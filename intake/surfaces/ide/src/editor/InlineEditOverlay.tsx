import { useEffect, useRef, useState } from 'react';
import { usePlatform } from '@/platform';
import { useUIStore } from '@/store/uiStore';
import type { InlineEditRequestDetail } from './types';
import { InlineEditService, replaceInlineSelection } from './InlineEditService';

export function InlineEditOverlay() {
  const { gateway } = usePlatform();
  const addToast = useUIStore((state) => state.addToast);
  const service = useRef(new InlineEditService());
  const abortRef = useRef<AbortController | null>(null);
  const [request, setRequest] = useState<InlineEditRequestDetail | null>(null);
  const [instruction, setInstruction] = useState('');
  const [replacement, setReplacement] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<InlineEditRequestDetail>).detail;
      if (!detail?.path) return;
      setRequest(detail); setInstruction(''); setReplacement(null); setError(null);
    };
    window.addEventListener('cursem:inline-edit-requested', listener);
    return () => { window.removeEventListener('cursem:inline-edit-requested', listener); abortRef.current?.abort(); };
  }, []);

  const close = () => { abortRef.current?.abort(); setRequest(null); setGenerating(false); setReplacement(null); setError(null); };
  const generate = async () => {
    if (!request || !instruction.trim() || generating) return;
    const controller = new AbortController(); abortRef.current = controller; setGenerating(true); setError(null);
    try { setReplacement(await service.current.rewrite(request, instruction.trim(), controller.signal)); }
    catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Inline Edit failed.'); }
    finally { if (abortRef.current === controller) abortRef.current = null; setGenerating(false); }
  };
  const apply = async () => {
    if (!request || replacement === null) return;
    try {
      const content = replaceInlineSelection(request, replacement);
      const preview = await gateway.agentPreviewPatch([{ path: request.path, content }]);
      const result = await gateway.agentApplyPatch(preview.proposalId, [preview.files[0].path], `Inline Edit: ${instruction.slice(0, 80)}`);
      window.dispatchEvent(new CustomEvent('cursem:external-edit', { detail: { path: request.path, content } }));
      addToast(`Applied Inline Edit with checkpoint ${result.checkpointId.slice(0, 8)}.`, 'success');
      close();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Inline Edit could not be applied.'); }
  };

  if (!request) return null;
  return <div className="dialog-backdrop inline-edit-backdrop" role="presentation"><section className="dialog inline-edit-dialog" role="dialog" aria-modal="true" aria-label="CURSEM Inline Edit">
    <header className="dialog-header"><div><strong>CURSEM Inline Edit</strong><span>{request.path} · lines {request.startLine}–{request.endLine}</span></div><button className="icon-button" onClick={close} aria-label="Close Inline Edit">×</button></header>
    <div className="inline-edit-body"><label><span>Instruction</span><textarea autoFocus value={instruction} onChange={(event) => setInstruction(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void generate(); }} placeholder="Describe the transformation…" /></label>
      <div className="inline-edit-comparison"><div><strong>Selected</strong><pre>{request.selectedText}</pre></div><div><strong>Proposed replacement</strong><pre>{replacement ?? 'Generate to preview the replacement.'}</pre></div></div>
      <p className="panel-caption">Apply writes the current editor buffer plus this replacement atomically and creates a durable checkpoint. A newer disk edit causes a conflict instead of an overwrite.</p>
      {error && <div className="provider-error" role="alert">{error}</div>}
    </div>
    <footer className="dialog-footer"><button className="button ghost" onClick={close}>Cancel</button>{generating ? <button className="button danger" onClick={() => abortRef.current?.abort()}>Stop</button> : <button className="button ghost" onClick={() => void generate()} disabled={!instruction.trim()}>Generate</button>}<button className="button primary" onClick={() => void apply()} disabled={replacement === null || generating}>Apply and checkpoint</button></footer>
  </section></div>;
}
