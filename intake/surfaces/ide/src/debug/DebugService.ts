// CURSE'M IDE — Debug Service (§10).
//
// §10: "Launch configurations stored per project."
// §10: "Breakpoints, continue, pause, step-in, step-over, and step-out."
// §10: "Variables, watches, call stack, and debug console."
// §10: "Debug output displayed through TerminalOne where a real terminal is required."
// §10: "Debug adapters run in the trusted backend, not inside browser JavaScript."
//
// All debug adapter execution happens in the trusted loopback backend. The IDE sends
// commands and displays results. Debug output that requires a real terminal
// is routed through TerminalOne.

import type {
  HostGateway,
  DebugConfig,
  DebugSession,
  DebugCommand,
  DebugVariable,
  DebugStackFrame,
} from '@/platform';

export class DebugService {
  private gateway: HostGateway;
  private activeSession: DebugSession | null = null;
  private outputHandlers = new Set<(output: string) => void>();
  private breakpointHandlers = new Set<(frame: DebugStackFrame) => void>();

  constructor(gateway: HostGateway) {
    this.gateway = gateway;
  }

  /** Launch a debug session (§10: "Launch configurations stored per project"). */
  async launch(config: DebugConfig): Promise<DebugSession> {
    const session = await this.gateway.debugLaunch(config);
    this.activeSession = session;
    return session;
  }

  /** Send a control command (§10: continue, pause, step-in, step-over, step-out). */
  async control(sessionId: string, command: DebugCommand): Promise<void> {
    return this.gateway.debugControl(sessionId, command);
  }

  /** Get variables (§10: "Variables, watches"). */
  async getVariables(sessionId: string, variablesReference?: number): Promise<DebugVariable[]> {
    return this.gateway.debugGetVariables(sessionId, variablesReference);
  }

  /** Get call stack (§10: "call stack"). */
  async getStackFrames(sessionId: string): Promise<DebugStackFrame[]> {
    return this.gateway.debugGetStackFrames(sessionId);
  }

  /** Subscribe to debug output (§10: "debug console"). */
  onOutput(callback: (output: string) => void): () => void {
    this.outputHandlers.add(callback);
    return () => { this.outputHandlers.delete(callback); };
  }

  /** Subscribe to breakpoint hits. */
  onBreakpoint(callback: (frame: DebugStackFrame) => void): () => void {
    this.breakpointHandlers.add(callback);
    return () => { this.breakpointHandlers.delete(callback); };
  }

  /** Get the active debug session. */
  getActiveSession(): DebugSession | null {
    return this.activeSession;
  }

  /** Terminate the active session. */
  async terminate(sessionId: string): Promise<void> {
    await this.gateway.debugControl(sessionId, 'disconnect');
    if (this.activeSession?.id === sessionId) {
      this.activeSession = null;
    }
  }
}
