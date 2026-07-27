// CURSE'M IDE — Platform hook (§8).
//
// Access the HostGateway, PlatformConfig, and event bus from any component.

import { useContext } from 'react';
import { PlatformContext } from './HostProvider';
import type { PlatformContextValue } from './HostProvider';

export function usePlatform(): PlatformContextValue {
  const ctx = useContext(PlatformContext);
  if (!ctx) {
    throw new Error('usePlatform must be used within a HostProvider');
  }
  return ctx;
}

// Convenience: access the gateway directly.
export function useGateway() {
  return usePlatform().gateway;
}

// Convenience: access the event bus directly.
export function useEventBus() {
  return usePlatform().eventBus;
}

// Convenience: access the config directly.
export function useConfig() {
  return usePlatform().config;
}
