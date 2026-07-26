export interface AttachArguments {
  sessionId: string;
  lastEventId?: string;
  runId?: string;
}

export function parseAttachArguments(args: string[]): AttachArguments {
  const [sessionId, ...rest] = args;
  if (!sessionId) throw new Error("usage: floyd attach <session_id> [last_event_id] [--run <run_id>]");

  let lastEventId: string | undefined;
  let runId: string | undefined;
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index]!;
    if (value === "--run") {
      const candidate = rest[index + 1];
      if (!candidate || runId) throw new Error("usage: floyd attach <session_id> [last_event_id] [--run <run_id>]");
      runId = candidate;
      index += 1;
      continue;
    }
    if (value.startsWith("--") || lastEventId !== undefined) {
      throw new Error("usage: floyd attach <session_id> [last_event_id] [--run <run_id>]");
    }
    lastEventId = value;
  }
  return { sessionId, ...(lastEventId ? { lastEventId } : {}), ...(runId ? { runId } : {}) };
}
