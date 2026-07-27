/** Read-only Floyd Experience presence for the PTY surface. */
export function init(T1) {
  const status = document.getElementById('floydStatus');
  const launch = document.getElementById('floydBtn');
  if (!status || !launch) return;

  let source = null;
  let stopped = false;

  function render(envelope) {
    const active = envelope?.active;
    const runId = typeof active?.run_id === 'string' ? active.run_id : '';
    const projectId = typeof active?.project_id === 'string' ? active.project_id : '';
    status.textContent = runId ? `Floyd active · ${runId.slice(0, 12)}` : 'Floyd ready · no active run';
    status.className = 'terminal-status connected';
    launch.title = runId
      ? `Continue Floyd run ${runId}${projectId ? ` in project ${projectId}` : ''}`
      : 'Launch Floyd with a new task context';
  }

  async function payload(response) {
    const text = await response.text();
    if (!text) return {};
    try { return JSON.parse(text); } catch (_) { return text; }
  }

  function message(value, fallback) {
    const raw = typeof value === 'string' ? value : (value?.error?.message || value?.message || fallback);
    // Keep this distinct from terminal connectivity: a working shell can
    // continue even when Floyd's shared project/run context is unavailable.
    return /fetch|network|abort|timeout/i.test(String(raw)) ? 'Floyd context unavailable' : raw;
  }

  async function request(path, options) {
    const response = await fetch(path, options);
    const body = await payload(response);
    if (!response.ok) throw new Error(message(body, `Floyd Core HTTP ${response.status}`));
    return body;
  }

  async function refresh() {
    const envelope = await request('/api/floyd/experience');
    render(envelope);
    return envelope;
  }

  async function publishPresence(envelope) {
    const response = await fetch('/api/floyd/experience/presence', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expected_revision: envelope.revision })
    });
    const body = await payload(response);
    if (response.status === 409) {
      await refresh();
      return;
    }
    if (!response.ok) throw new Error(message(body, `Floyd Core HTTP ${response.status}`));
    render(body);
  }

  function watch() {
    source = new EventSource('/api/floyd/experience/stream');
    source.addEventListener('experience', (event) => {
      try { render(JSON.parse(event.data)); } catch (_) {}
    });
    source.addEventListener('error', () => {
      if (stopped) return;
      status.textContent = 'Floyd context unavailable';
      status.className = 'terminal-status error';
    });
  }

  (async () => {
    try {
      await request('/api/floyd/experience/negotiate', { method: 'POST' });
      const envelope = await refresh();
      await publishPresence(envelope);
      watch();
    } catch (error) {
      status.textContent = message(error, 'Floyd context unavailable');
      status.className = 'terminal-status error';
    }
  })();

  window.addEventListener('pagehide', () => {
    stopped = true;
    source?.close();
    source = null;
  }, { once: true });
}
