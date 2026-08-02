import type { HostGateway, AgentTaskRequest } from '@/platform';
import type { ConversationMessage, ConversationRequest, UnifiedEvent } from '@/model-routing/core.mjs';
import type { PolicyModelClient, PolicyRoutingConfig } from '@/model-routing';
import { parseAgentToolCall, type AgentToolCall } from './protocol';

const MAX_TOOL_ITERATIONS = 16;
const MAX_TOOL_RESULT_CHARS = 64 * 1024;
const MAX_PROTOCOL_CORRECTIONS = 2;

export interface AgentRunnerOptions {
  gateway: HostGateway;
  client: Pick<PolicyModelClient, 'stream'>;
  runId: string;
  workspaceRoot: string;
  routing: PolicyRoutingConfig;
  messages: ConversationMessage[];
  request?: Omit<ConversationRequest, 'messages'>;
  signal: AbortSignal;
  onDelta?: (text: string) => void;
  onUsage?: (usage: Record<string, number>) => void;
  onFallback?: (requestedProvider: string, model: string) => void;
  onTool?: (tool: AgentToolCall, phase: 'started' | 'completed' | 'failed') => void;
  validateFinal?: (text: string) => string | null;
}

export interface AgentRunnerResult {
  text: string;
  usage: Record<string, number> | null;
  toolCalls: number;
}

/** Foreground tool loop with cancellation and steer-at-message-boundary support. */
export class AgentRunner {
  private current: AbortController | null = null;
  private steering: string[] = [];

  steer(message: string): void {
    const value = message.trim(); if (!value) return;
    this.steering.push(value);
    // Aborting only the active provider stream releases relay/provider sockets.
    // run() recognizes the queued steering message and immediately resumes with
    // it in context instead of classifying the parent run as cancelled.
    this.current?.abort('steer');
  }

  async run(options: AgentRunnerOptions): Promise<AgentRunnerResult> {
    const conversation = [...options.messages];
    let finalText = ''; let usage = null; let toolCalls = 0; let protocolCorrections = 0;
    const abortCurrent = () => this.current?.abort(options.signal.reason);
    options.signal.addEventListener('abort', abortCurrent, { once: true });
    try {
      for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
        if (options.signal.aborted) throw abortError();
        while (this.steering.length) conversation.push({ role: 'user', content: `<steering>${this.steering.shift()}</steering>` });
        const controller = new AbortController(); this.current = controller;
        let response = '';
        try {
          for await (const event of options.client.stream(options.routing, { messages: conversation, maxTokens: options.request?.maxTokens || 4096, temperature: options.request?.temperature ?? 0.2 }, controller.signal)) {
            if (event.type === 'delta') { response += event.text; options.onDelta?.(event.text); }
            else if (event.type === 'usage') { usage = event.usage; options.onUsage?.(event.usage); }
            else if (event.type === 'fallback') options.onFallback?.(event.requestedProvider, event.model);
            else if (event.type === 'error') throw new Error(formatToolError(event));
          }
        } catch (error) {
          if (options.signal.aborted) throw abortError();
          if (controller.signal.aborted && this.steering.length) {
            if (response) conversation.push({ role: 'assistant', content: `${response}\n\n[Interrupted by user steering]` });
            options.onDelta?.('\n\n↪ Steering applied\n\n');
            continue;
          }
          throw error;
        } finally { if (this.current === controller) this.current = null; }

        let tool: AgentToolCall | null;
        try { tool = parseAgentToolCall(response); }
        catch (error) {
          const message = error instanceof Error ? error.message : 'The provider returned an invalid tool request.';
          if (protocolCorrections >= MAX_PROTOCOL_CORRECTIONS) throw protocolFailure(message);
          protocolCorrections += 1;
          await appendProtocolCorrection(options, conversation, response, message);
          continue;
        }
        if (!tool) {
          if (!response.trim()) throw new Error('The selected model completed without returning visible text. Choose a model that returns assistant content for this task.');
          const validationError = options.validateFinal?.(response);
          if (validationError) {
            if (protocolCorrections >= MAX_PROTOCOL_CORRECTIONS) throw protocolFailure(validationError);
            protocolCorrections += 1;
            await appendProtocolCorrection(options, conversation, response, validationError);
            continue;
          }
          finalText = response;
          return { text: finalText, usage, toolCalls };
        }
        toolCalls += 1;
        conversation.push({ role: 'assistant', content: response });
        options.onTool?.(tool, 'started');
        await options.gateway.agentAppendEvent(options.runId, 'tool.started', { id: tool.id, name: tool.name, arguments: tool.arguments });
        try {
          const result = await executeTool(options.gateway, options.workspaceRoot, tool, options.signal);
          const serialized = JSON.stringify(result).slice(0, MAX_TOOL_RESULT_CHARS);
          conversation.push({ role: 'user', content: `<tool-result id=${JSON.stringify(tool.id)} name=${JSON.stringify(tool.name)}>\n${serialized}\n</tool-result>` });
          await options.gateway.agentAppendEvent(options.runId, 'tool.completed', { id: tool.id, name: tool.name, result: evidenceResult(result) });
          options.onTool?.(tool, 'completed');
          options.onDelta?.(`\n\n✓ ${tool.name}\n\n`);
        } catch (error) {
          if (options.signal.aborted) throw abortError();
          const message = error instanceof Error ? error.message : String(error);
          conversation.push({ role: 'user', content: `<tool-result id=${JSON.stringify(tool.id)} name=${JSON.stringify(tool.name)} error="true">\n${JSON.stringify({ error: message })}\n</tool-result>` });
          await options.gateway.agentAppendEvent(options.runId, 'tool.failed', { id: tool.id, name: tool.name, message });
          options.onTool?.(tool, 'failed');
          options.onDelta?.(`\n\n⚠ ${tool.name}: ${message}\n\n`);
        }
      }
      throw new Error(`Agent exceeded ${MAX_TOOL_ITERATIONS} tool iterations.`);
    } finally {
      options.signal.removeEventListener('abort', abortCurrent);
      this.current?.abort(); this.current = null; this.steering = [];
    }
  }
}

async function appendProtocolCorrection(options: AgentRunnerOptions, conversation: ConversationMessage[], response: string, message: string) {
  conversation.push({ role: 'assistant', content: response });
  conversation.push({ role: 'user', content: `<protocol-error>${message} Use only the exact CURSEM protocol described in the system instructions, then continue the task.</protocol-error>` });
  await options.gateway.agentAppendEvent(options.runId, 'model.protocol_error', { message });
  options.onDelta?.(`\n\n↻ ${message}\n\n`);
}

async function executeTool(gateway: HostGateway, workspaceRoot: string, tool: AgentToolCall, signal: AbortSignal): Promise<unknown> {
  const args = tool.arguments;
  if (tool.name === 'search') return gateway.contextSearch(requiredString(args.query, 'query'), numberArg(args.limit, 20));
  if (tool.name === 'read_file') return gateway.contextResolve([{ type: 'file', value: requiredString(args.path, 'path') }], numberArg(args.maxChars, 64 * 1024));
  if (tool.name === 'list_dir') return gateway.listDir(typeof args.path === 'string' ? args.path : workspaceRoot);
  if (tool.name === 'git_diff') return { diff: await gateway.gitDiff(workspaceRoot, typeof args.path === 'string' ? args.path : undefined) };
  if (tool.name === 'rules') return gateway.contextRules(typeof args.path === 'string' ? args.path : '');
  if (tool.name === 'mcp') return gateway.mcpCallTool(requiredString(args.server, 'server'), requiredString(args.tool, 'tool'), args.arguments && typeof args.arguments === 'object' && !Array.isArray(args.arguments) ? args.arguments as Record<string, unknown> : {});
  if (tool.name === 'run_task') {
    const request: AgentTaskRequest = {
      executable: requiredString(args.executable, 'executable'),
      args: Array.isArray(args.args) ? args.args.map((value) => String(value)) : [],
      cwd: typeof args.cwd === 'string' ? args.cwd : workspaceRoot,
      timeoutMs: numberArg(args.timeoutMs, 60_000),
    };
    return gateway.agentRunTask(request, signal);
  }
  throw new Error(`Unsupported tool: ${tool.name}`);
}

function requiredString(value: unknown, name: string) { if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required.`); return value.trim(); }
function numberArg(value: unknown, fallback: number) { return Number.isFinite(value) ? Number(value) : fallback; }
function abortError() { return new DOMException('Agent run cancelled.', 'AbortError'); }
function protocolFailure(message: string) { return new Error(`Provider failed the CURSEM tool/edit protocol after ${MAX_PROTOCOL_CORRECTIONS} correction attempts: ${message}`); }
function formatToolError(event: Extract<UnifiedEvent, { type: 'error' }>) { return typeof event.error === 'string' ? event.error : JSON.stringify(event.error); }
function evidenceResult(result: unknown) {
  if (!result || typeof result !== 'object') return result;
  const object = result as Record<string, unknown>;
  return { ...object, ...(typeof object.stdout === 'string' ? { stdout: object.stdout.slice(0, 16_384) } : {}), ...(typeof object.stderr === 'string' ? { stderr: object.stderr.slice(0, 16_384) } : {}) };
}
