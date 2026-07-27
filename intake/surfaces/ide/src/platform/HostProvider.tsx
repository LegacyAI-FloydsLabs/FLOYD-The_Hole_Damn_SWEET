// CURSE'M IDE — Host Provider (§8).
//
// React context provider that makes the HostGateway and PlatformConfig
// available to all IDE subsystems.

import React, { createContext, useMemo } from 'react';
import type { PlatformConfig } from './types';
import type { HostGateway } from './host';
import type { PlatformEventBus } from './events';

export interface PlatformContextValue {
  gateway: HostGateway;
  config: PlatformConfig;
  eventBus: PlatformEventBus;
}

export const PlatformContext = createContext<PlatformContextValue | null>(null);

export interface HostProviderProps {
  config: PlatformConfig;
  gateway: HostGateway;
  children: React.ReactNode;
}

export function HostProvider({ config, gateway, children }: HostProviderProps) {
  const value = useMemo<PlatformContextValue>(
    () => ({
      gateway,
      config,
      eventBus: gateway.eventBus,
    }),
    [gateway, config],
  );

  return (
    <PlatformContext.Provider value={value}>
      {children}
    </PlatformContext.Provider>
  );
}
