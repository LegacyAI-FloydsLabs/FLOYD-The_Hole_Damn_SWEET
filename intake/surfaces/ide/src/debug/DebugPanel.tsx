// CURSE'M IDE — Debug Panel (§10).
//
// Displays debug controls, variables, call stack, and debug console.
// Launch configurations are stored per project.

import { useState, useEffect } from 'react';
import { usePlatform } from '@/platform';
import { useWorkspace } from '@/workspace';
import { DebugService } from './DebugService';
import type { AgentTaskResult, DebugStackFrame, DebugVariable, WorkspaceTask } from '@/platform';
import { Icon, type IconName } from '@/components/Icon';
import { useUIStore } from '@/store/uiStore';

function DebugAction({ icon, label, onClick }: { icon: IconName; label: string; onClick: () => void }) {
  return <button className="debug-button" onClick={onClick}><Icon name={icon} size={14} /> <span>{label}</span></button>;
}

export function DebugPanel() {
  const { gateway } = usePlatform();
  const { workspaceId, workspaceRoot } = useWorkspace();
  const [service, setService] = useState<DebugService | null>(null);
  const [running, setRunning] = useState(false);
  const [paused, setPaused] = useState(false);
  const [stackFrames, setStackFrames] = useState<DebugStackFrame[]>([]);
  const [variables, setVariables] = useState<DebugVariable[]>([]);
  const [output, setOutput] = useState<string[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [program, setProgram] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [tasks, setTasks] = useState<WorkspaceTask[]>([]);
  const [taskResult, setTaskResult] = useState<AgentTaskResult | null>(null);
  const [activeTask, setActiveTask] = useState<string | null>(null);
  const toggleAIChat = useUIStore((state) => state.toggleAIChat);
  const aiChatVisible = useUIStore((state) => state.aiChatVisible);

  useEffect(() => {
    const svc = new DebugService(gateway);
    setService(svc);

    const unsubscribeOutput = svc.onOutput((line) => {
      setOutput((prev) => [...prev.slice(-100), line]);
    });

    return unsubscribeOutput;
  }, [gateway]);

  useEffect(() => { void gateway.taskList().then(setTasks).catch((reason) => setError(reason instanceof Error ? reason.message : 'Task discovery failed.')); }, [gateway, workspaceRoot]);

  const runTask = async (task: WorkspaceTask) => {
    setActiveTask(task.id); setTaskResult(null); setError(null);
    try { setTaskResult(await gateway.taskRun(task)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Task failed to start.'); }
    finally { setActiveTask(null); }
  };

  const attachTaskResult = () => {
    if (!taskResult) return;
    const content = `Workspace task evidence\nCommand: ${taskResult.executable} ${taskResult.args.join(' ')}\nExit code: ${taskResult.exitCode}\nDuration: ${taskResult.durationMs}ms\n\nstdout:\n${taskResult.stdout}\n\nstderr:\n${taskResult.stderr}`;
    window.dispatchEvent(new CustomEvent('cursem:agent-context', { detail: { content } }));
    if (!aiChatVisible) toggleAIChat();
  };

  const handleLaunch = async () => {
    if (!service) return;
    try {
      setError(null);
      const session = await service.launch({
        name: 'Launch',
        type: 'node',
        request: 'launch',
        projectId: workspaceId,
        program,
        cwd: workspaceRoot,
      });
      setSessionId(session.id);
      setRunning(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Debug launch failed.');
    }
  };

  const handleControl = async (command: 'continue' | 'pause' | 'step-in' | 'step-over' | 'step-out' | 'disconnect') => {
    if (!service || !sessionId) { setError('Start a debug session before using debug controls.'); return; }
    try {
      setError(null);
      if (command === 'disconnect') {
        await service.terminate(sessionId);
        setRunning(false);
        setPaused(false);
        setSessionId(null);
        setStackFrames([]);
        setVariables([]);
        return;
      }
      await service.control(sessionId, command);
      if (command === 'pause') setPaused(true);
      if (command === 'continue') setPaused(false);

      if (paused || command === 'pause') {
        const frames = await service.getStackFrames(sessionId);
        setStackFrames(frames);
        if (frames.length > 0) setVariables(await service.getVariables(sessionId));
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : `Debug ${command} failed.`);
    }
  };

  return (
    <div className="debug-panel">
      <div className="git-section">
        <div className="git-section-title">Debug — {workspaceId}</div>
        {!running && <label style={{ display: 'block', margin: '8px 0' }}><span style={{ display: 'block', marginBottom: 4, color: 'var(--color-text-secondary)' }}>Node program</span><input value={program} onChange={(event) => setProgram(event.target.value)} placeholder="src/index.js" style={{ width: '100%' }} /></label>}
        {error && <div role="alert" style={{ color: 'var(--color-error)', marginBottom: 6 }}>{error}</div>}
        <div style={{ marginTop: 4 }}>
          {!running ? (
            <button className="debug-button" onClick={handleLaunch} disabled={!program.trim()}><Icon name="play" size={14} /> <span>Launch</span></button>
          ) : (
            <>
              {paused ? (
                <DebugAction icon="play" label="Continue" onClick={() => handleControl('continue')} />
              ) : (
                <DebugAction icon="pause" label="Pause" onClick={() => handleControl('pause')} />
              )}
              <DebugAction icon="step-over" label="Step Over" onClick={() => handleControl('step-over')} />
              <DebugAction icon="step-in" label="Step In" onClick={() => handleControl('step-in')} />
              <DebugAction icon="step-out" label="Step Out" onClick={() => handleControl('step-out')} />
              <DebugAction icon="stop" label="Stop" onClick={() => handleControl('disconnect')} />
            </>
          )}
        </div>
      </div>

      <div className="git-section">
        <div className="git-section-title">Tasks & Tests <span>{tasks.length}</span></div>
        {tasks.map((task) => <div key={task.id} className="git-file-item"><span><strong>{task.label}</strong><small style={{ display: 'block', color: 'var(--color-text-secondary)' }}>{task.kind} · {task.source}</small></span><button className="button ghost" aria-label={activeTask === task.id ? `Running ${task.label}` : `Run ${task.label}`} disabled={activeTask !== null} onClick={() => void runTask(task)}>{activeTask === task.id ? 'Running…' : 'Run'}</button></div>)}
        {!tasks.length && <div className="panel-caption">No package, Cargo, Go, Python, Make, or safe `.vscode/tasks.json` tasks were discovered.</div>}
        {taskResult && <div className="task-result" role="status"><strong>{taskResult.exitCode === 0 ? 'Passed' : 'Failed'} · exit {taskResult.exitCode} · {taskResult.durationMs}ms</strong><pre>{[taskResult.stdout, taskResult.stderr].filter(Boolean).join('\n') || '(no output)'}</pre><button className="button ghost" onClick={attachTaskResult}>Attach visible evidence to Agent</button></div>}
      </div>

      {stackFrames.length > 0 && (
        <div className="git-section">
          <div className="git-section-title">Call Stack</div>
          {stackFrames.map((frame) => (
            <div key={frame.id} className="git-file-item">
              <span>{frame.name}</span>
              <span style={{ color: 'var(--color-text-secondary)', marginLeft: 'auto' }}>
                {frame.source}:{frame.line}
              </span>
            </div>
          ))}
        </div>
      )}

      {variables.length > 0 && (
        <div className="git-section">
          <div className="git-section-title">Variables</div>
          {variables.map((v) => (
            <div key={v.name} className="git-file-item">
              <span style={{ color: 'var(--color-accent)' }}>{v.name}</span>
              <span style={{ marginLeft: 8 }}>{v.value}</span>
            </div>
          ))}
        </div>
      )}

      {output.length > 0 && (
        <div className="git-section">
          <div className="git-section-title">Debug Console</div>
          <div style={{ fontFamily: 'monospace', fontSize: 12, padding: '4px 8px' }}>
            {output.map((line, i) => (
              <div key={i} style={{ whiteSpace: 'pre-wrap' }}>{line}</div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
