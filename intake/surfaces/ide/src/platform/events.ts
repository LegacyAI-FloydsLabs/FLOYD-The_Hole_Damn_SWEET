// CURSE'M IDE — Platform Event Bus (§8).
//
// "It should expose host events including:
//   file.opened, file.selected, selection.changed, file.saved,
//   diagnostics.changed, workspace.changed, terminal.requested,
//   opencode.context.requested"
//
// The event bus is the mechanism by which the IDE emits events that Floyd
// Desktop and other platform components can subscribe to. It also relays
// events from the host gateway back to IDE subsystems.

import type { HostEvent, HostEventType } from './types';

export type EventHandler = (event: HostEvent) => void;

export class PlatformEventBus {
  private handlers = new Map<HostEventType | '*', Set<EventHandler>>();
  private history: HostEvent[] = [];
  private readonly historyLimit = 100;

  /** Subscribe to a specific event type, or '*' for all events. */
  on(eventType: HostEventType | '*', handler: EventHandler): () => void {
    let set = this.handlers.get(eventType);
    if (!set) {
      set = new Set();
      this.handlers.set(eventType, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
      if (set!.size === 0) this.handlers.delete(eventType);
    };
  }

  /** Emit an event to all matching subscribers. */
  emit(event: HostEvent): void {
    // Store in history for late subscribers (e.g., reconnection scenarios).
    this.history.push(event);
    if (this.history.length > this.historyLimit) {
      this.history.shift();
    }

    // Specific handlers.
    const specific = this.handlers.get(event.type);
    if (specific) {
      for (const handler of specific) {
        try {
          handler(event);
        } catch (err) {
          console.error('[event-bus] handler error:', err);
        }
      }
    }

    // Wildcard handlers.
    const wildcard = this.handlers.get('*');
    if (wildcard) {
      for (const handler of wildcard) {
        try {
          handler(event);
        } catch (err) {
          console.error('[event-bus] wildcard handler error:', err);
        }
      }
    }
  }

  /** Get recent events (for reconnection / state recovery). */
  getHistory(eventType?: HostEventType): HostEvent[] {
    if (!eventType) return [...this.history];
    return this.history.filter((e) => e.type === eventType);
  }

  /** Clear all handlers and history. */
  destroy(): void {
    this.handlers.clear();
    this.history = [];
  }
}
