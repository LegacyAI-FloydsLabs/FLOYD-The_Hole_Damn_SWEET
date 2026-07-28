/**
 * Browork Manager - Sub-agent delegation system like Claude Cowork
 * Spawns autonomous agents to work on tasks in parallel
 * Supports both Anthropic and OpenAI
 */

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
import { ToolExecutor } from './tool-executor.js';
import { BUILTIN_TOOLS } from './mcp-client.js';
import { GATEWAY_TOOLS, isGatewayTool, executeGatewayTool, gatewayAvailable } from './mcp-gateway.js';
import { chronoAfterToolCall } from './chrono-hook.js';
import {
  ChatGPTSubscriptionClient,
  userMessage as chatgptUserMessage,
  toolResult as chatgptToolResult,
  type ResponseInputItem,
} from './chatgpt-subscription.js';
import { vaultConnectorBaseURL } from './vault-model-connectors.js';

export type Provider = 'chatgpt-subscription' | 'anthropic' | 'openai' | 'glm' | 'anthropic-compatible';

export type AgentStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface AgentTask {
  id: string;
  name: string;
  description: string;
  status: AgentStatus;
  progress: number;
  created: number;
  started?: number;
  completed?: number;
  result?: string;
  error?: string;
  logs: Array<{
    timestamp: number;
    type: 'info' | 'tool' | 'thinking' | 'error';
    message: string;
  }>;
  toolCalls: Array<{
    tool: string;
    args: Record<string, unknown>;
    result?: any;
    timestamp: number;
  }>;
}

export interface BroworkConfig {
  maxConcurrentAgents: number;
  maxToolCallsPerAgent: number;
  agentTimeout: number;
}

const DEFAULT_CONFIG: BroworkConfig = {
  maxConcurrentAgents: 3,
  maxToolCallsPerAgent: 20,
  agentTimeout: 5 * 60 * 1000,
};

export class BroworkManager {
  private tasks: Map<string, AgentTask> = new Map();
  private runningCount = 0;
  private config: BroworkConfig = DEFAULT_CONFIG;
  private toolExecutor: ToolExecutor;
  private vaultToken: string = '';
  private vaultUrl: string = '';
  private model: string = 'claude-sonnet-4-5-20250514';
  private provider: Provider = 'anthropic';
  private connectorId?: string;
  private chatgptClient: ChatGPTSubscriptionClient | null = null;
  private onUpdate?: (task: AgentTask) => void;

  constructor(toolExecutor: ToolExecutor) {
    this.toolExecutor = toolExecutor;
  }

  configureVault(token: string, url: string) {
    if (!/^fv_/.test(token) || !/^http:\/\/127\.0\.0\.1:\d+$/.test(url)) throw new Error('Browork requires Vault routing');
    this.vaultToken = token;
    this.vaultUrl = url.replace(/\/+$/, '');
  }
  setModel(model: string) { this.model = model; }
  setProvider(provider: Provider) { this.provider = provider; }
  setConnector(connectorId?: string) { this.connectorId = connectorId; }
  setChatGPTClient(client: ChatGPTSubscriptionClient) { this.chatgptClient = client; }
  setConfig(config: Partial<BroworkConfig>) { this.config = { ...this.config, ...config }; }
  setUpdateCallback(cb: (task: AgentTask) => void) { this.onUpdate = cb; }

  createTask(name: string, description: string): AgentTask {
    const task: AgentTask = {
      id: uuidv4(),
      name,
      description,
      status: 'pending',
      progress: 0,
      created: Date.now(),
      logs: [],
      toolCalls: [],
    };
    this.tasks.set(task.id, task);
    return task;
  }

  async startTask(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error('Task not found');
    if (task.status !== 'pending') throw new Error('Task already started');
    if (this.runningCount >= this.config.maxConcurrentAgents) {
      throw new Error(`Max concurrent agents (${this.config.maxConcurrentAgents}) reached`);
    }
    if (this.provider === 'chatgpt-subscription') {
      if (!this.chatgptClient) throw new Error('ChatGPT client not configured');
    } else if (!this.vaultToken || !this.vaultUrl) throw new Error('Vault route not configured');
    if (this.provider === 'anthropic-compatible' && !this.connectorId) {
      throw new Error('Anthropic-compatible Browork requires a configured Vault connector');
    }

    task.status = 'running';
    task.started = Date.now();
    this.runningCount++;
    this.notifyUpdate(task);

    this.runAgent(task).catch(err => {
      task.status = 'failed';
      task.error = err.message;
      this.log(task, 'error', `Agent failed: ${err.message}`);
      this.runningCount--;
      this.notifyUpdate(task);
    });
  }

  cancelTask(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    if (task.status === 'running') {
      task.status = 'cancelled';
      task.completed = Date.now();
      this.runningCount--;
      this.log(task, 'info', 'Task cancelled by user');
      this.notifyUpdate(task);
    }
    return true;
  }

  getTasks(): AgentTask[] {
    return Array.from(this.tasks.values()).sort((a, b) => b.created - a.created);
  }

  getTask(taskId: string): AgentTask | undefined {
    return this.tasks.get(taskId);
  }

  deleteTask(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    if (task.status === 'running') this.cancelTask(taskId);
    return this.tasks.delete(taskId);
  }

  clearFinished(): number {
    let cleared = 0;
    for (const [id, task] of this.tasks) {
      if (['completed', 'failed', 'cancelled'].includes(task.status)) {
        this.tasks.delete(id);
        cleared++;
      }
    }
    return cleared;
  }

  private log(task: AgentTask, type: 'info' | 'tool' | 'thinking' | 'error', message: string) {
    task.logs.push({ timestamp: Date.now(), type, message });
  }

  private notifyUpdate(task: AgentTask) {
    if (this.onUpdate) this.onUpdate({ ...task });
  }

  private async runAgent(task: AgentTask): Promise<void> {
    const systemPrompt = `You are a Browork agent - an autonomous sub-agent working on a specific task.

Your task: ${task.name}
Description: ${task.description}

Instructions:
1. Work autonomously to complete the task
2. Use tools as needed to accomplish your goal
3. Be efficient - don't make unnecessary tool calls
4. Report progress as you work
5. When finished, provide a clear summary of what you accomplished

You have access to file system tools, command execution, and code execution.
Work step by step and complete the task.`;

    this.log(task, 'info', `Agent started (${this.provider})`);
    task.progress = 10;
    this.notifyUpdate(task);

    try {
      if (this.provider === 'chatgpt-subscription') {
        await this.runChatGPTAgent(task, systemPrompt);
      } else if (this.provider === 'openai' || this.provider === 'glm') {
        await this.runOpenAIAgent(task, systemPrompt);
      } else {
        await this.runAnthropicAgent(task, systemPrompt);
      }

      if (task.status === 'running') {
        task.status = 'completed';
        task.progress = 100;
        task.completed = Date.now();
        task.result = 'Task completed (max turns reached)';
        this.log(task, 'info', 'Task completed (reached turn limit)');
      }
    } catch (err: any) {
      task.status = 'failed';
      task.error = err.message;
      task.completed = Date.now();
      this.log(task, 'error', `Error: ${err.message}`);
    } finally {
      this.runningCount--;
      this.notifyUpdate(task);
    }
  }

  private async runAnthropicAgent(task: AgentTask, systemPrompt: string): Promise<void> {
    const client = new Anthropic({
      apiKey: this.vaultToken,
      baseURL: this.provider === 'anthropic-compatible'
        ? vaultConnectorBaseURL(this.vaultUrl, this.connectorId ?? '')
        : `${this.vaultUrl}/p/anthropic`,
    });
    const agentTools = [...BUILTIN_TOOLS, ...(gatewayAvailable() ? GATEWAY_TOOLS : [])];
    const tools = agentTools.map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema as { type: 'object'; properties: Record<string, unknown>; required?: string[] },
    }));

    const messages: any[] = [
      { role: 'user', content: `Please complete this task: ${task.description}` }
    ];

    let toolCallCount = 0;
    const maxTurns = 15;

    for (let turn = 0; turn < maxTurns && task.status === 'running'; turn++) {
      if (Date.now() - task.started! > this.config.agentTimeout) {
        throw new Error('Agent timeout exceeded');
      }

      const response = await client.messages.create({
        model: this.model,
        max_tokens: 4096,
        system: systemPrompt,
        messages,
        tools,
      });

      let hasToolUse = false;
      const toolResults: any[] = [];
      let textContent = '';

      for (const block of response.content) {
        if (block.type === 'text') {
          textContent += block.text;
          this.log(task, 'thinking', block.text.slice(0, 200) + (block.text.length > 200 ? '...' : ''));
        } else if (block.type === 'tool_use') {
          hasToolUse = true;
          toolCallCount++;
          if (toolCallCount > this.config.maxToolCallsPerAgent) throw new Error('Max tool calls exceeded');

          this.log(task, 'tool', `Using ${block.name}`);
          const result = isGatewayTool(block.name) ? await executeGatewayTool(block.name, block.input as Record<string, unknown>) : await this.toolExecutor.execute(block.name, block.input as Record<string, unknown>);
          chronoAfterToolCall(block.name, block.input as Record<string, unknown>, result.success);

          task.toolCalls.push({
            tool: block.name,
            args: block.input as Record<string, unknown>,
            result: result.success ? result.result : { error: result.error },
            timestamp: Date.now(),
          });

          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(result.success ? result.result : { error: result.error }),
          } as any);

          task.progress = Math.min(90, 10 + (toolCallCount / this.config.maxToolCallsPerAgent) * 80);
          this.notifyUpdate(task);
        }
      }

      messages.push({ role: 'assistant', content: response.content });
      if (hasToolUse && toolResults.length > 0) {
        messages.push({ role: 'user', content: toolResults });
      }

      if (response.stop_reason === 'end_turn' && !hasToolUse) {
        task.result = textContent;
        task.status = 'completed';
        task.progress = 100;
        task.completed = Date.now();
        this.log(task, 'info', 'Task completed successfully');
        break;
      }
    }
  }

  private async runChatGPTAgent(task: AgentTask, systemPrompt: string): Promise<void> {
    const client = this.chatgptClient!;
    const agentTools = [...BUILTIN_TOOLS, ...(gatewayAvailable() ? GATEWAY_TOOLS : [])];
    const tools = agentTools.map(tool => ({
      type: 'function' as const,
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema as Record<string, unknown>,
    }));

    const input: ResponseInputItem[] = [chatgptUserMessage(`Please complete this task: ${task.description}`)];

    let toolCallCount = 0;
    const maxTurns = 15;

    for (let turn = 0; turn < maxTurns && task.status === 'running'; turn++) {
      if (Date.now() - task.started! > this.config.agentTimeout) {
        throw new Error('Agent timeout exceeded');
      }

      const result = await client.runTurn({
        model: this.model,
        instructions: systemPrompt,
        input,
        tools,
      });

      if (result.text) {
        this.log(task, 'thinking', result.text.slice(0, 200) + (result.text.length > 200 ? '...' : ''));
      }
      input.push(...result.outputItems);

      if (result.toolCalls.length === 0) {
        task.result = result.text;
        task.status = 'completed';
        task.progress = 100;
        task.completed = Date.now();
        this.log(task, 'info', 'Task completed successfully');
        return;
      }

      for (const call of result.toolCalls) {
        toolCallCount++;
        if (toolCallCount > this.config.maxToolCallsPerAgent) throw new Error('Max tool calls exceeded');
        this.log(task, 'tool', `Using ${call.name}`);
        const toolRes = isGatewayTool(call.name) ? await executeGatewayTool(call.name, call.args) : await this.toolExecutor.execute(call.name, call.args);
        chronoAfterToolCall(call.name, call.args, toolRes.success);
        task.toolCalls.push({
          tool: call.name,
          args: call.args,
          result: toolRes.success ? toolRes.result : { error: toolRes.error },
          timestamp: Date.now(),
        });
        input.push(chatgptToolResult(call.callId, toolRes.success ? toolRes.result : { error: toolRes.error }));
        task.progress = Math.min(90, 10 + (toolCallCount / this.config.maxToolCallsPerAgent) * 80);
        this.notifyUpdate(task);
      }
    }
  }

  private async runOpenAIAgent(task: AgentTask, systemPrompt: string): Promise<void> {
    const client = new OpenAI({ 
      apiKey: this.vaultToken,
      baseURL: this.provider === 'glm' ? `${this.vaultUrl}/p/zai/api/coding/paas/v4` : `${this.vaultUrl}/v1`,
    });
    const agentTools = [...BUILTIN_TOOLS, ...(gatewayAvailable() ? GATEWAY_TOOLS : [])];
    const tools = agentTools.map(tool => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));

    const messages: any[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Please complete this task: ${task.description}` }
    ];

    let toolCallCount = 0;
    const maxTurns = 15;

    for (let turn = 0; turn < maxTurns && task.status === 'running'; turn++) {
      if (Date.now() - task.started! > this.config.agentTimeout) {
        throw new Error('Agent timeout exceeded');
      }

      const response = await client.chat.completions.create({
        model: this.model,
        max_tokens: 4096,
        messages,
        tools,
      });

      const choice = response.choices[0];
      const assistantMessage = choice.message;
      let textContent = assistantMessage.content || '';

      if (textContent) {
        this.log(task, 'thinking', textContent.slice(0, 200) + (textContent.length > 200 ? '...' : ''));
      }

      if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
        messages.push(assistantMessage);

        for (const toolCall of assistantMessage.tool_calls) {
          toolCallCount++;
          if (toolCallCount > this.config.maxToolCallsPerAgent) throw new Error('Max tool calls exceeded');

          const toolName = (toolCall as any).function.name;
          const toolArgs = JSON.parse((toolCall as any).function.arguments);

          this.log(task, 'tool', `Using ${toolName}`);
          const result = isGatewayTool(toolName) ? await executeGatewayTool(toolName, toolArgs) : await this.toolExecutor.execute(toolName, toolArgs);
          chronoAfterToolCall(toolName, toolArgs, result.success);

          task.toolCalls.push({
            tool: toolName,
            args: toolArgs,
            result: result.success ? result.result : { error: result.error },
            timestamp: Date.now(),
          });

          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify(result.success ? result.result : { error: result.error }),
          });

          task.progress = Math.min(90, 10 + (toolCallCount / this.config.maxToolCallsPerAgent) * 80);
          this.notifyUpdate(task);
        }
      } else {
        task.result = textContent;
        task.status = 'completed';
        task.progress = 100;
        task.completed = Date.now();
        this.log(task, 'info', 'Task completed successfully');
        break;
      }

      if (choice.finish_reason === 'stop') {
        task.result = textContent;
        task.status = 'completed';
        task.progress = 100;
        task.completed = Date.now();
        this.log(task, 'info', 'Task completed successfully');
        break;
      }
    }
  }
}
