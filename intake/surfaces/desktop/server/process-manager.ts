/**
 * Process Manager - Interactive process control like Desktop Commander
 * Manages long-running processes, sessions, and interactive shells
 */

import { spawn, ChildProcess, exec } from 'child_process';
import { promisify } from 'util';
import { EventEmitter } from 'events';

const execAsync = promisify(exec);

interface ProcessSession {
  id: string;
  pid: number;
  process: ChildProcess;
  command: string;
  cwd: string;
  startTime: number;
  output: string[];
  isRunning: boolean;
  exitCode: number | null;
}

interface ProcessInfo {
  pid: number;
  name: string;
  cpu: string;
  memory: string;
  command: string;
}

export class ProcessManager extends EventEmitter {
  private sessions: Map<string, ProcessSession> = new Map();
  private sessionCounter = 0;
  private maxOutputLines = 1000;
  private defaultShell = process.platform === 'win32' ? 'cmd.exe' : '/bin/bash';

  constructor() {
    super();
  }

  /**
   * Start a new process/session
   */
  async startProcess(options: {
    command: string;
    cwd?: string;
    shell?: string;
    timeout?: number;
  }): Promise<{ sessionId: string; pid: number; initialOutput: string }> {
    const sessionId = `session_${++this.sessionCounter}`;
    const cwd = options.cwd || process.cwd();
    const shell = options.shell || this.defaultShell;
    
    return new Promise((resolve, reject) => {
      try {
        const proc = spawn(shell, ['-c', options.command], {
          cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: false,
        });

        const session: ProcessSession = {
          id: sessionId,
          pid: proc.pid!,
          process: proc,
          command: options.command,
          cwd,
          startTime: Date.now(),
          output: [],
          isRunning: true,
          exitCode: null,
        };

        this.sessions.set(sessionId, session);

        // Capture stdout
        proc.stdout?.on('data', (data) => {
          const lines = data.toString().split('\n');
          session.output.push(...lines);
          // Trim output if too long
          if (session.output.length > this.maxOutputLines) {
            session.output = session.output.slice(-this.maxOutputLines);
          }
          this.emit('output', { sessionId, data: data.toString() });
        });

        // Capture stderr
        proc.stderr?.on('data', (data) => {
          const lines = data.toString().split('\n');
          session.output.push(...lines.map((l: string) => `[stderr] ${l}`));
          if (session.output.length > this.maxOutputLines) {
            session.output = session.output.slice(-this.maxOutputLines);
          }
          this.emit('output', { sessionId, data: data.toString(), isError: true });
        });

        proc.on('close', (code) => {
          session.isRunning = false;
          session.exitCode = code;
          this.emit('close', { sessionId, exitCode: code });
        });

        proc.on('error', (err) => {
          session.isRunning = false;
          this.emit('error', { sessionId, error: err.message });
        });

        // Wait a bit for initial output
        const timeout = options.timeout || 2000;
        setTimeout(() => {
          resolve({
            sessionId,
            pid: proc.pid!,
            initialOutput: session.output.join('\n'),
          });
        }, Math.min(timeout, 2000));

      } catch (err: any) {
        reject(err);
      }
    });
  }

  /**
   * Send input to a running process
   */
  async interactWithProcess(sessionId: string, input: string): Promise<{
    success: boolean;
    output: string;
    isRunning: boolean;
  }> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { success: false, output: 'Session not found', isRunning: false };
    }

    if (!session.isRunning) {
      return { 
        success: false, 
        output: `Process exited with code ${session.exitCode}`, 
        isRunning: false 
      };
    }

    // Clear current output buffer to capture new output
    const outputBefore = session.output.length;
    
    // Send input
    session.process.stdin?.write(input + '\n');

    // Wait for response
    await new Promise(resolve => setTimeout(resolve, 500));

    const newOutput = session.output.slice(outputBefore).join('\n');

    return {
      success: true,
      output: newOutput || '(no new output)',
      isRunning: session.isRunning,
    };
  }

  /**
   * Read output from a process
   */
  readProcessOutput(sessionId: string, lines?: number): {
    output: string;
    isRunning: boolean;
    exitCode: number | null;
  } {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { output: 'Session not found', isRunning: false, exitCode: null };
    }

    const outputLines = lines 
      ? session.output.slice(-lines) 
      : session.output;

    return {
      output: outputLines.join('\n'),
      isRunning: session.isRunning,
      exitCode: session.exitCode,
    };
  }

  /**
   * Force terminate a session
   */
  forceTerminate(sessionId: string): { success: boolean; message: string } {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { success: false, message: 'Session not found' };
    }

    if (!session.isRunning) {
      return { success: true, message: 'Process already terminated' };
    }

    try {
      session.process.kill('SIGKILL');
      session.isRunning = false;
      return { success: true, message: `Terminated session ${sessionId}` };
    } catch (err: any) {
      return { success: false, message: err.message };
    }
  }

  /**
   * List all active sessions
   */
  listSessions(): Array<{
    id: string;
    pid: number;
    command: string;
    cwd: string;
    isRunning: boolean;
    runtime: number;
  }> {
    const result: Array<{
      id: string;
      pid: number;
      command: string;
      cwd: string;
      isRunning: boolean;
      runtime: number;
    }> = [];

    for (const [id, session] of this.sessions) {
      result.push({
        id,
        pid: session.pid,
        command: session.command,
        cwd: session.cwd,
        isRunning: session.isRunning,
        runtime: Date.now() - session.startTime,
      });
    }

    return result;
  }

  /**
   * List system processes
   */
  async listProcesses(): Promise<ProcessInfo[]> {
    try {
      if (process.platform === 'win32') {
        const { stdout } = await execAsync('tasklist /FO CSV /NH');
        return stdout.split('\n')
          .filter(line => line.trim())
          .slice(0, 50)
          .map(line => {
            const parts = line.split(',').map(p => p.replace(/"/g, ''));
            return {
              pid: parseInt(parts[1]) || 0,
              name: parts[0],
              cpu: 'N/A',
              memory: parts[4] || 'N/A',
              command: parts[0],
            };
          });
      } else {
        const { stdout } = await execAsync('ps aux | head -50');
        const lines = stdout.split('\n').slice(1); // Skip header
        return lines
          .filter(line => line.trim())
          .map(line => {
            const parts = line.split(/\s+/);
            return {
              pid: parseInt(parts[1]) || 0,
              name: parts[10] || '',
              cpu: parts[2] || '0',
              memory: parts[3] || '0',
              command: parts.slice(10).join(' '),
            };
          });
      }
    } catch {
      return [];
    }
  }

  /**
   * Kill a process by PID
   */
  async killProcess(pid: number): Promise<{ success: boolean; message: string }> {
    try {
      process.kill(pid, 'SIGTERM');
      return { success: true, message: `Sent SIGTERM to process ${pid}` };
    } catch (err: any) {
      return { success: false, message: err.message };
    }
  }

  /**
   * Execute code in memory without saving to file
   */
  async executeCode(options: {
    language: 'python' | 'node' | 'bash';
    code: string;
    timeout?: number;
  }): Promise<{ success: boolean; output: string; error?: string }> {
    const { language, code, timeout = 30000 } = options;

    let command: string;
    switch (language) {
      case 'python':
        command = `python3 -c ${JSON.stringify(code)}`;
        break;
      case 'node':
        command = `node -e ${JSON.stringify(code)}`;
        break;
      case 'bash':
        command = code;
        break;
      default:
        return { success: false, output: '', error: `Unsupported language: ${language}` };
    }

    try {
      const { stdout, stderr } = await execAsync(command, { timeout });
      return {
        success: true,
        output: stdout,
        error: stderr || undefined,
      };
    } catch (err: any) {
      return {
        success: false,
        output: err.stdout || '',
        error: err.stderr || err.message,
      };
    }
  }

  /**
   * Clean up dead sessions
   */
  cleanup(): number {
    let cleaned = 0;
    for (const [id, session] of this.sessions) {
      if (!session.isRunning) {
        this.sessions.delete(id);
        cleaned++;
      }
    }
    return cleaned;
  }
}
