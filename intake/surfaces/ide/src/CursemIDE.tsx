// CURSE'M IDE — embeddable IDE component.
//
// §1: "Mounts inside Floyd Desktop under a configurable route such as /ide."
// §1: "Supports configurable base paths; no assumption that it runs at /."
//
// This is the single export point. Floyd Desktop imports this component,
// provides a PlatformConfig and HostGateway, and mounts it.

import { HostProvider } from './platform/HostProvider';
import { WorkspaceProvider } from './workspace/WorkspaceProvider';
import type { PlatformConfig } from '@/platform';
import { type HostGateway } from '@/platform/host';
import { AppShell } from './components/AppShell';

export interface CursemIDEProps {
  /** Platform configuration from Floyd Desktop. */
  config: PlatformConfig;
  /** Host gateway — handles all privileged operations (FS, Git, LSP, terminal, debug). */
  gateway: HostGateway;
}

export function CursemIDE({ config, gateway }: CursemIDEProps) {
  return (
    <HostProvider config={config} gateway={gateway}>
      <WorkspaceProvider>
        <AppShell />
      </WorkspaceProvider>
    </HostProvider>
  );
}
