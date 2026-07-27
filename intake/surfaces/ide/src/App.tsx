// CURSE'M IDE — development app shell.
//
// Wraps CursemIDE with a dev-mode HostGateway that reads configuration
// from URL params and environment variables. In production, Floyd Desktop
// provides the HostGateway directly to CursemIDE.

import { useEffect, useMemo, useState } from 'react';
import { CursemIDE } from './CursemIDE';
import { HttpHostGateway, type HostGateway } from '@/platform/host';
import type { PlatformConfig } from '@/platform';

function buildDevConfig(): PlatformConfig {
  // §1: "No hard-coded ports, hostnames, workspace paths, or credentials."
  // All from env or URL params.
  const params = new URLSearchParams(window.location.search);
  const basePath = __CURSEM_BASE_PATH__;

  // Dev gateway base URL — defaults to same origin.
  const gatewayUrl =
    params.get('gateway') ||
    import.meta.env.VITE_GATEWAY_URL ||
    `${window.location.origin}`;

  // Workspace — from URL param or env, never hardcoded.
  const workspaceRoot =
    params.get('workspace') ||
    import.meta.env.VITE_WORKSPACE_ROOT ||
    '';

  const workspaceId =
    params.get('workspaceId') ||
    import.meta.env.VITE_WORKSPACE_ID ||
    (workspaceRoot ? workspaceRoot.replace(/[^a-zA-Z0-9]/g, '-') : 'dev');

  // OpenCode instance URL.
  const opencodeUrl =
    params.get('opencode') ||
    import.meta.env.VITE_OPENCODE_URL ||
    '';

  return {
    workspaceId,
    workspaceRoot,
    gatewayUrl,
    opencodeUrl,
    basePath,
    // Dev mode: no auth token in the URL. The dev gateway handles auth.
    authToken: undefined,
  };
}

export default function App() {
  const [config, setConfig] = useState<PlatformConfig>(buildDevConfig);
  const [ready, setReady] = useState(Boolean(config.workspaceRoot));
  const gateway: HostGateway = useMemo(() => new HttpHostGateway(config), [config]);

  useEffect(() => {
    if (config.workspaceRoot) { setReady(true); return; }
    let cancelled = false;
    gateway.getWorkspace()
      .then((workspace) => {
        if (cancelled || !workspace) return;
        setConfig((current) => ({ ...current, workspaceId: workspace.id, workspaceRoot: workspace.root }));
        setReady(true);
      })
      .catch(() => setReady(true));
    return () => { cancelled = true; };
  }, [config.workspaceRoot, gateway]);

  if (!ready) return <div className="standalone-loading">Opening CURSEM IDE…</div>;

  return <CursemIDE config={config} gateway={gateway} />;
}
