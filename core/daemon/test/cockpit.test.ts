import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const html = readFileSync(join(import.meta.dirname, "../../../quarantine/cockpit/public/index.html"), "utf8");
const browserSdk = readFileSync(join(import.meta.dirname, "../../../packages/sdk/browser/floyd-sdk.js"), "utf8");

test("cockpit is a natural-language Core client without direct engine access", () => {
  assert.match(html, /Natural-language coding partner/);
  assert.match(html, /import \{ FloydBrowserClient, FloydApiError \} from "\/floyd-sdk\.js"/);
  assert.match(html, /client\.submit\(projectId, text\)/);
  assert.match(html, /client\.attachSession\(sessionId, actor/);
  assert.match(html, /client\.steer\(app\.currentSessionId/);
  assert.doesNotMatch(html, /127\.0\.0\.1:41415|\/api\/session\/|@opencode-ai\/sdk/);
  assert.doesNotMatch(html, /EventSource\(|\bfetch\(/);
});

test("cockpit has inline question and permission controls with no emoji glyphs", () => {
  assert.match(html, /data-question-index/);
  assert.match(html, /data-permission-index/);
  assert.match(html, /Allow once/);
  assert.match(html, /Reject/);
  assert.doesNotMatch(html, /[⚙🔐😀-🙏🌀-🫿]/u);
});

test("cockpit Surface Hub exposes exactly the five admitted Floyd surfaces", () => {
  assert.match(html, /id="surfaceHub"/);
  assert.match(html, /id="surfaceDialog"/);
  const start = html.indexOf("const FLOYD_SURFACES");
  const end = html.indexOf("const app =", start);
  assert.ok(start >= 0 && end > start);
  const surfaces = new Function(`${html.slice(start, end)}; return FLOYD_SURFACES;`)() as Array<Record<string, string>>;
  assert.deepEqual(surfaces.map(({ id }) => id), ["desktop", "ide", "tui", "pty", "launcher"]);
  assert.deepEqual(surfaces.filter(({ kind }) => kind === "url").map(({ target }) => target), [
    "http://127.0.0.1:13010/",
    "http://127.0.0.1:13012/",
    "http://127.0.0.1:13013/",
    "http://127.0.0.1:13014/",
  ]);
  assert.doesNotMatch(html.slice(start, end), /127\.0\.0\.1:(?:3001|10001|11001|11000)/);
});

test("Surface Hub launch targets are credential-free and TUI continuation is shell-safe", () => {
  const start = html.indexOf("function shellQuote");
  const end = html.indexOf("function activeSurfaceProject", start);
  assert.ok(start >= 0 && end > start);
  const helpers = new Function(`const remoteMode = false; const app = { surfaceAvailability: new Map() }; const location = { hostname: "127.0.0.1" }; ${html.slice(start, end)}; return { shellQuote, safeSurfaceUrl, continuationCommand };`)() as {
    shellQuote: (value: string) => string;
    safeSurfaceUrl: (surface: Record<string, string>) => string;
    continuationCommand: (
      project: { id: string; root_path: string } | null,
      active: { session_id?: string; run_id?: string; last_event_id?: string } | null,
    ) => string | null;
  };
  assert.equal(helpers.safeSurfaceUrl({ id: "ide", kind: "url", target: "http://127.0.0.1:13012/" }), "http://127.0.0.1:13012/");
  for (const target of [
    "https://127.0.0.1:13012/",
    "http://example.com/",
    "http://user:secret@127.0.0.1:13012/",
    "http://127.0.0.1:13012/?token=secret",
    "http://127.0.0.1:13012/#run=run-1",
  ]) assert.throws(() => helpers.safeSurfaceUrl({ id: "bad", kind: "url", target }), /Unsafe launch target/);
  const command = helpers.continuationCommand(
    { id: "project-'one", root_path: "/tmp/Floyd's work" },
    { session_id: "session-'one", run_id: "run-1", last_event_id: "42" },
  );
  assert.equal(command, "cd -- '/tmp/Floyd'\"'\"'s work' && '/Volumes/Storage/FLOYD_RUNTIME/bin/floyd-tui' floyd --project-id 'project-'\"'\"'one' --session 'session-'\"'\"'one' --run 'run-1' --event '42'");
  assert.equal(helpers.continuationCommand(null, null), null);
  assert.doesNotMatch(command!, /(token|api[_-]?key|credential|secret)/i);
  assert.match(command!, /floyd --project-id/);
  assert.match(command!, /--session 'session-/);
  assert.match(command!, /--run 'run-1'/);
  assert.match(command!, /--event '42'/);
});

test("Surface Hub reports Core-restored continuity and the authenticated remote relay boundary", () => {
  assert.match(html, /Floyd unified workspace/);
  assert.match(html, /id="surfaceFrame"/);
  assert.match(html, /id="surfaceTabs"/);
  assert.match(html, /Core continuation envelope/);
  assert.match(html, /app\.envelope\?\.active/);
  assert.match(html, /app\.envelope\?\.last_event_id/);
  assert.match(html, /Floyd Core remains the continuity authority/);
  assert.match(html, /every application request is device-session authenticated/);
  assert.match(html, /revoke the device session to cut it off/);
  assert.match(html, /client\.request\("GET", "\/api\/surfaces", undefined, controller\.signal\)/);
  assert.match(html, /entry\?\.id === surface\.id[\s\S]*remoteMode \|\| entry\?\.target === surface\.target/);
  assert.doesNotMatch(html, /Remote continuation cannot verify or open workstation loopback applications/);
  assert.match(html, /data-surface-open=/);
  assert.match(html, /function openIntegratedSurface/);
  assert.match(html, /app\.surfaceAvailability\.get\(surface\.id\)\?\.verified !== true/);
  assert.match(html, /if \(remoteMode && app\.surfaceAvailability\.get\(surface\.id\)\?\.verified !== true\) return null/);
  assert.match(html, /target\.searchParams\.set\("floyd", "continue"\)/);
  assert.match(html, /target\.searchParams\.set\("floyd", "integrated"\)/);
  assert.match(html, /frame\.src = target/);
  assert.match(html, /floyd:continue-context/);
  assert.match(html, /surfaceNavigation: Promise\.resolve\(\)/);
  assert.match(html, /function enqueueSurfaceNavigation/);
  assert.match(html, /experienceReady: null/);
  assert.match(html, /if \(app\.experienceReady\) await app\.experienceReady/);
  assert.match(html, /await restoreEnvelope\(await client\.experience\(envelopeId\)\)/);
  assert.match(html, /const requestId = crypto\.randomUUID\(\)/);
  assert.match(html, /postMessage\(\{ type: "floyd:surface-close", requestId \}, childOrigin\)/);
  assert.match(html, /event\.data\?\.type !== "floyd:surface-closed"/);
  assert.match(html, /\["pty", "launcher", "tui"\]\.includes\(app\.integratedSurfaceId\)/);
  assert.match(html, /if \(!acknowledged\)[\s\S]*kept it visible instead of detaching a hidden session/);
  assert.match(html, /frame\.src = "about:blank"/);
  const terminalTeardown = html.match(/if \(\["pty", "launcher", "tui"\]\.includes\(app\.integratedSurfaceId\)\)[\s\S]*?\n  }\n  frame\.src = "about:blank"/);
  assert.ok(terminalTeardown, "terminal teardown block is present");
  assert.doesNotMatch(terminalTeardown[0], /catch/, "a missing acknowledgement cannot be swallowed before frame unload");
  assert.match(html, /window\.open\(target, "_blank", "noopener,noreferrer"\)/);
  assert.doesNotMatch(html, /[?&#](token|secret|api_key|session_id|run_id|last_event_id)=/i);
});

test("remote cockpit is continuation-only and disables local authority controls", () => {
  assert.match(html, /const remoteMode =/);
  assert.match(html, /Remote continuation cannot create a new run/);
  assert.match(html, /Run decisions require the local authority surface/);
  assert.match(html, /Private remote continuation/);
  assert.match(html, /\["newTask", "modelSettings", "shareHandoff", "acceptRun", "rejectRun", "escalateRun"\]/);
  assert.match(html, /data-connected-app-select=/);
  assert.match(html, /\$\{remoteMode \? "disabled" : ""\}/);
  assert.match(html, /Remote continuation can use it but cannot expand its authority/);
  assert.match(html, /el\("connectedApps"\)\.addEventListener\("click", \(\) => openConnectedApps\(\)\.catch\(notify\)\)/);
  assert.match(html, /client\.pairExperienceHandoff\(handoffToken\)/);
  assert.match(html, /async function confirmRemoteDeviceSession/);
  assert.match(html, /\[401, 403\]\.includes\(error\.status\)/);
  assert.match(html, /await confirmRemoteDeviceSession\(\)/);
  assert.match(html, /history\.replaceState/);
  assert.match(html, /establishLocalBrowserSession/);
  assert.match(html, /"\/api\/local-session"/);
  assert.doesNotMatch(html, /(sessionStorage|localStorage)\.(getItem|setItem|removeItem)\([^\n]*floyd_gateway_token/);
});

test("cockpit renders a local QR handoff without emoji or external image services", () => {
  assert.match(html, /id="shareHandoff"/);
  assert.match(html, /id="handoffQr"/);
  assert.match(html, /handoff\.qr_svg/);
  assert.match(html, /client\.issueExperienceHandoff/);
  assert.match(html, /new Blob\(\[handoff\.qr_svg\]/);
  assert.match(html, /client\.revokeExperienceHandoff/);
  assert.doesNotMatch(html, /handoffQr"\)\.innerHTML/);
  assert.doesNotMatch(html, /id="handoffLink"/);
  assert.doesNotMatch(html, /api\.qrserver|chart\.googleapis|quickchart/);
  assert.match(html, /Page exit sends a best-effort authenticated revocation/);
  assert.match(html, /grant expires within two minutes/);
});

test("cockpit exposes user-driven model routing without persisting provider keys", () => {
  assert.match(html, /id="modelSettings"/);
  assert.match(html, /opencode-go/);
  assert.match(html, /opencode-zen/);
  assert.match(html, /data-model-apply/);
  assert.match(html, /client\.modelStream/);
  assert.match(browserSdk, /x-floyd-token/);
  assert.match(browserSdk, /x-floyd-provider/);
  assert.match(browserSdk, /x-api-key/);
  assert.doesNotMatch(html, /sessionStorage\.setItem\([^\n]*modelKey|localStorage\.setItem\([^\n]*modelKey/);
  assert.match(html, /location\.hash/);
  assert.doesNotMatch(html, /query\.get\("token"\)/);
  assert.match(html, /client\.connectors\(\)/);
  assert.match(html, /client\.createConnector\(input\)/);
  assert.match(html, /client\.storeConnectorApiKey/);
  assert.match(html, /client\.startConnectorOAuth/);
  assert.match(html, /client\.completeConnectorOAuth/);
  assert.match(html, /client\.revokeConnector/);
  assert.match(html, /credentialRef: app\.modelRoute\.credentialRef/);
  assert.match(html, /normally use API keys/);
});

test("cockpit keeps connected-application OAuth server-owned and separate from model credentials", () => {
  assert.match(html, /id="connectedApps"/);
  assert.match(html, /client\.connectedApps\(\)/);
  assert.match(html, /client\.createConnectedApp/);
  assert.match(html, /client\.startConnectedAppOAuth/);
  assert.match(html, /client\.refreshConnectedApp/);
  assert.match(html, /client\.revokeConnectedApp/);
  assert.match(html, /https:\/\/mcp\.notion\.com\/mcp/);
  const connectedSection = html.slice(html.indexOf("function renderConnectedAppsSettings"), html.indexOf("function shellQuote"));
  assert.doesNotMatch(connectedSection, /credentialRef|access_token|refresh_token/);
  assert.doesNotMatch(connectedSection, /completeConnectedAppOAuth/);
});

test("cockpit connector selection publishes only opaque credential references", async () => {
  const start = html.indexOf("async function selectConnector");
  const end = html.indexOf("async function openModelSettings", start);
  const patches: Array<Record<string, any>> = [];
  const app = { modelKey: "raw-key-must-be-cleared", modelRoute: { model: "gpt-test" } };
  const selectConnector = new Function("app", "patchEnvelope", `${html.slice(start, end)}; return selectConnector;`)(
    app, async (patch: Record<string, unknown>) => { patches.push(patch); },
  ) as (profile: Record<string, string>, credentialRef?: string) => Promise<void>;
  await selectConnector({ id: "personal", provider: "openai", baseUrl: "https://api.openai.com/v1", credentialRef: "floyd-connector:personal" });
  assert.equal(app.modelKey, "");
  assert.equal((app.modelRoute as Record<string, unknown>).credentialRef, "floyd-connector:personal");
  assert.equal(patches[0]?.model_route.credential_ref, "floyd-connector:personal");
  assert.equal(JSON.stringify(patches).includes("raw-key-must-be-cleared"), false);
});

test("cockpit OAuth callback parsing fails closed and connector input keeps secrets out of storage", () => {
  const inputStart = html.indexOf("function oauthCallbackInput");
  const inputEnd = html.indexOf("async function completeOAuthCallback", inputStart);
  const helpers = new Function(`${html.slice(inputStart, inputEnd)}; return { oauthCallbackInput, connectorProfileInput };`)() as {
    oauthCallbackInput: (params: URLSearchParams) => { state: string; code: string } | null;
    connectorProfileInput: (values: Record<string, string>) => Record<string, unknown>;
  };
  assert.equal(helpers.oauthCallbackInput(new URLSearchParams()), null);
  assert.throws(() => helpers.oauthCallbackInput(new URLSearchParams("state=only")), /both state and code/);
  assert.deepEqual(helpers.oauthCallbackInput(new URLSearchParams("state=s&code=c")), { state: "s", code: "c" });
  const profile = helpers.connectorProfileInput({
    id: " oauth-main ", displayName: " OAuth Main ", provider: "openai", baseUrl: " https://api.openai.com/v1 ",
    authorizationUrl: "https://provider.example/authorize", tokenUrl: "https://provider.example/token",
    clientId: "client", clientSecret: "profile-secret", scopes: "openid models",
  });
  assert.deepEqual(profile.scopes, ["openid", "models"]);
  assert.equal(profile.clientAuth, "client_secret_post");
  assert.doesNotMatch(html, /(sessionStorage|localStorage)\.setItem\([^\n]*(connector|credential|clientSecret|modelKey)/);
  const capture = html.slice(html.indexOf("const hadOAuthCallbackParams"), html.indexOf("const token ="));
  assert.match(capture, /query\.delete\("state"\)/);
  assert.match(capture, /history\.replaceState/);
  assert.ok(html.indexOf("const hadOAuthCallbackParams") < html.indexOf("await refreshHealth\(\)"));
  const completion = html.slice(html.indexOf("async function completeOAuthCallback"), html.indexOf("function shellQuote"));
  assert.doesNotMatch(completion.slice(completion.indexOf("await client.completeConnectorOAuth")), /query\.delete\("state"\)/);
});

test("cockpit model stream requires an explicit terminal event and surfaces exact errors", async () => {
  const start = html.indexOf("async function consumeModelStream");
  const end = html.indexOf("async function sendPrompt", start);
  const consume = new Function(`${html.slice(start, end)}; return consumeModelStream;`)() as (
    events: AsyncIterable<{ type: string; data: Record<string, unknown> }>,
    onDelta: (text: string) => void,
  ) => Promise<void>;
  const stream = (values: Array<{ type: string; data: Record<string, unknown> }>) => (async function* () { yield* values; })();
  const deltas: string[] = [];
  await consume(stream([{ type: "delta", data: { text: "ok" } }, { type: "done", data: {} }]), (text) => deltas.push(text));
  assert.deepEqual(deltas, ["ok"]);
  await assert.rejects(
    consume(stream([{ type: "error", data: { error: { message: "vendor denied", code: "rate_limit" } } }]), () => {}),
    /vendor denied.*rate_limit/,
  );
  await assert.rejects(consume(stream([{ type: "delta", data: { text: "partial" } }]), () => {}), /before a terminal done or error/);
});

test("cockpit restores and publishes the portable Core experience envelope", () => {
  assert.match(html, /client\.negotiateExperience/);
  assert.match(html, /client\.experience\(envelopeId\)/);
  assert.match(html, /client\.updateExperience/);
  assert.match(html, /client\.watchExperience/);
  assert.match(html, /event\.type === "transcript"/);
  assert.match(html, /restoreTranscriptSnapshot/);
  assert.match(html, /composer_draft/);
  assert.match(html, /transcript_cursor/);
  assert.match(html, /last_event_id/);
  assert.match(html, /selected_artifact_id/);
  assert.match(html, /client\.artifactById/);
  assert.match(html, /model_route/);
  assert.match(html, /capabilities: \["coding-runs", "model-chat", "questions", "permissions", "artifacts", "drafts", "experience-stream"\]/);
  assert.doesNotMatch(html, /(sessionStorage|localStorage)\.(getItem|setItem)\([^\n]*(modelRoute|model_route|composer|draft)/);
});

test("cockpit detects conflicting cross-surface writes instead of blindly retrying", () => {
  const start = html.indexOf("function valueEqual");
  const end = html.indexOf("async function patchEnvelope");
  assert.ok(start >= 0 && end > start);
  const helpers = new Function(`${html.slice(start, end)}; return { envelopeChangeApplied, envelopeChangeConflicts };`)() as {
    envelopeChangeApplied: (envelope: Record<string, unknown>, change: Record<string, unknown>) => boolean;
    envelopeChangeConflicts: (base: Record<string, unknown>, latest: Record<string, unknown>, change: Record<string, unknown>) => boolean;
  };
  const base = { composer_draft: "base", transcript_cursor: 4, active: { run_id: "run-a" } };
  assert.equal(helpers.envelopeChangeConflicts(base, { ...base, composer_draft: "remote" }, { composer_draft: "local" }), true);
  assert.equal(helpers.envelopeChangeConflicts(base, { ...base, transcript_cursor: 9 }, { composer_draft: "local" }), false);
  assert.equal(helpers.envelopeChangeApplied({ ...base, composer_draft: "local" }, { composer_draft: "local" }), true);
});

test("cockpit's actual 409 path retains conflicting Core state and retries only independent fields", async () => {
  class MockApiError extends Error {
    status = 409;
    payload: unknown;
    constructor(envelope: unknown) { super("conflict"); this.payload = { envelope }; }
  }
  const source = html.slice(html.indexOf("function valueEqual"), html.indexOf("function scheduleDraftSave"));
  const makePatch = (app: Record<string, any>, client: Record<string, any>) => new Function(
    "app", "client", "FloydApiError", "surfaceId", "envelopeId",
    `${source}; return patchEnvelope;`,
  )(app, client, MockApiError, "cockpit-test", "primary") as (change: Record<string, unknown>) => Promise<unknown>;

  const base = { revision: 1, composer_draft: "base", transcript_cursor: 4, last_event_id: "4" };
  const remoteDraft = { ...base, revision: 2, composer_draft: "remote" };
  let calls = 0;
  const app = { envelope: base };
  const patch = makePatch(app, {
    updateExperience: async () => { calls += 1; throw new MockApiError(remoteDraft); },
    experience: async () => remoteDraft,
  });
  await assert.rejects(() => patch({ composer_draft: "local" }), /Latest Core state was kept/);
  assert.equal(calls, 1);
  assert.equal(app.envelope, remoteDraft);

  const cursorAdvanced = { ...base, revision: 2, transcript_cursor: 9, last_event_id: "9" };
  calls = 0;
  const independentApp = { envelope: base };
  const independentPatch = makePatch(independentApp, {
    updateExperience: async (_id: string, body: Record<string, unknown>) => {
      calls += 1;
      if (calls === 1) throw new MockApiError(cursorAdvanced);
      return { ...cursorAdvanced, revision: 3, composer_draft: body.composer_draft };
    },
    experience: async () => cursorAdvanced,
  });
  const merged = await independentPatch({ composer_draft: "local" }) as { composer_draft: string };
  assert.equal(calls, 2);
  assert.equal(merged.composer_draft, "local");
});

test("cockpit preserves a pending local draft when a newer remote draft arrives", async () => {
  const start = html.indexOf("function draftChangeConflicts");
  const end = html.indexOf("function clearPendingCursorSave", start);
  const callbacks: Array<() => Promise<void>> = [];
  const writes: Array<Record<string, unknown>> = [];
  const notices: Error[] = [];
  const app = {
    envelope: { revision: 1, composer_draft: "base" },
    draftBase: null,
    draftLocalValue: "",
    draftDiverged: false,
    draftTimer: null,
  };
  const schedule = new Function(
    "app", "patchEnvelope", "notify", "setTimeout", "clearTimeout",
    `${html.slice(start, end)}; return scheduleDraftSave;`,
  )(
    app,
    async (change: Record<string, unknown>) => { writes.push(change); },
    (error: Error) => notices.push(error),
    (callback: () => Promise<void>) => { callbacks.push(callback); return callbacks.length; },
    () => {},
  ) as (value: string) => void;

  schedule("local");
  app.envelope = { revision: 2, composer_draft: "remote" };
  await callbacks.shift()!();
  assert.deepEqual(writes, []);
  assert.equal(app.draftDiverged, true);
  assert.match(notices[0]?.message ?? "", /changed on another surface/);

  schedule("local explicit edit");
  await callbacks.shift()!();
  assert.deepEqual(writes, [{ composer_draft: "local explicit edit" }]);
});

test("cockpit deduplicates only provider parts proven present in the transcript snapshot", () => {
  const start = html.indexOf("function deduplicatedLiveText");
  const end = html.indexOf("async function refreshHealth");
  const app = { snapshotParts: new Map([["run-a", new Map([["part-a", "hello"]])]]) };
  const deduplicate = new Function("app", `${html.slice(start, end)}; return deduplicatedLiveText;`)(app) as (
    runId: string,
    data: unknown,
  ) => string;
  assert.equal(deduplicate("run-a", { delta: "l", part: { id: "part-a", text: "hel" } }), "");
  assert.equal(deduplicate("run-a", { delta: "lo", part: { id: "part-a", text: "hello" } }), "");
  assert.equal(deduplicate("run-a", { delta: " world", part: { id: "part-a", text: "hello world" } }), " world");
  assert.equal(deduplicate("run-a", { delta: "unidentified" }), "unidentified");
});

test("cockpit discards delayed cursor writes after a run or epoch change", () => {
  const start = html.indexOf("function clearPendingCursorSave");
  const end = html.indexOf("async function restoreEnvelope");
  const callbacks: Array<() => void> = [];
  const writes: unknown[] = [];
  const app = {
    cursorTimer: null,
    cursorPending: null,
    currentRunId: "run-a",
    envelope: { transcript_epoch: "epoch-a" },
  };
  const helpers = new Function(
    "app", "patchEnvelope", "notify", "setTimeout", "clearTimeout",
    `${html.slice(start, end)}; return { scheduleCursorSave, clearPendingCursorSave };`,
  )(
    app,
    async (change: unknown) => { writes.push(change); },
    () => {},
    (callback: () => void) => { callbacks.push(callback); return callbacks.length; },
    () => {},
  ) as { scheduleCursorSave: (id: string) => void; clearPendingCursorSave: () => void };

  helpers.scheduleCursorSave("40");
  app.currentRunId = "run-b";
  callbacks.shift()!();
  assert.deepEqual(writes, []);

  helpers.scheduleCursorSave("5");
  app.envelope.transcript_epoch = "epoch-b";
  callbacks.shift()!();
  assert.deepEqual(writes, []);

  helpers.scheduleCursorSave("6");
  helpers.clearPendingCursorSave();
  assert.equal(app.cursorPending, null);
  assert.equal(app.cursorTimer, null);
});

test("cockpit ignores a stale out-of-order run selection", async () => {
  const start = html.indexOf("async function selectRun");
  const end = html.indexOf("function attachSession", start);
  const deferred = () => {
    let resolve!: (value: Record<string, unknown>) => void;
    const promise = new Promise<Record<string, unknown>>((done) => { resolve = done; });
    return { promise, resolve };
  };
  const runA = deferred();
  const runB = deferred();
  const inspectorA = deferred();
  const attachments: string[] = [];
  const patches: Array<Record<string, unknown>> = [];
  const app = {
    runSelectionGeneration: 0,
    activeContextPublish: Promise.resolve<unknown>(undefined),
    streamAbort: null,
    cursorTimer: null,
    cursorPending: null,
    modelKey: "",
    restoredArtifactId: null,
    currentRunId: null,
    currentRun: null,
    currentSessionId: null,
    mode: "",
    transcripts: new Map(),
    restoringEnvelope: false,
  };
  const selectRun = new Function(
    "app", "client", "clearPendingCursorSave", "renderRuns", "renderHeader", "renderMessages",
    "renderInspector", "attachSession", "patchEnvelope", "queueActiveContextPublish", "el",
    `${html.slice(start, end)}; return selectRun;`,
  )(
    app,
    { run: (id: string) => id === "run-a" ? runA.promise : runB.promise },
    () => {}, () => {}, () => {}, () => {},
    async (id: string) => id === "run-a" ? (await inspectorA.promise, true) : true,
    (id: string) => attachments.push(id),
    async (change: Record<string, unknown>) => { patches.push(change); },
    async (_generation: number, change: Record<string, unknown>) => { patches.push(change); return true; },
    (id: string) => id === "prompt" ? { value: "draft" } : { textContent: "" },
  ) as (id: string) => Promise<void>;

  const selectingA = selectRun("run-a");
  runA.resolve({ id: "run-a", session_id: "session-a", project_id: "project-a", goal: "A", status: "running" });
  await new Promise((resolve) => setImmediate(resolve));
  const selectingB = selectRun("run-b");
  runB.resolve({ id: "run-b", session_id: "session-b", project_id: "project-b", goal: "B", status: "running" });
  await selectingB;
  inspectorA.resolve({});
  await selectingA;

  assert.equal(app.currentRunId, "run-b");
  assert.deepEqual(attachments, ["run-b"]);
  assert.deepEqual(patches.map((patch) => (patch.active as { run_id: string }).run_id), ["run-b"]);
});

test("cockpit serializes overlapping active-run publications and leaves the newest authoritative", async () => {
  const start = html.indexOf("async function selectRun");
  const end = html.indexOf("function attachSession", start);
  let releaseA!: () => void;
  let enteredA!: () => void;
  const aEntered = new Promise<void>((resolve) => { enteredA = resolve; });
  const aBlocked = new Promise<void>((resolve) => { releaseA = resolve; });
  const publications: string[] = [];
  const attachments: string[] = [];
  const app = {
    runSelectionGeneration: 0,
    activeContextPublish: Promise.resolve<unknown>(undefined),
    streamAbort: null,
    cursorTimer: null,
    cursorPending: null,
    modelKey: "",
    restoredArtifactId: null,
    currentRunId: null,
    currentRun: null,
    currentSessionId: null,
    mode: "",
    transcripts: new Map(),
    restoringEnvelope: false,
  };
  const queueActiveContextPublish = (generation: number, change: Record<string, any>) => {
    const publish = async () => {
      if (generation !== app.runSelectionGeneration) return false;
      const runId = change.active.run_id;
      publications.push(runId);
      if (runId === "run-a") { enteredA(); await aBlocked; }
      return generation === app.runSelectionGeneration;
    };
    const queued = app.activeContextPublish.then(publish, publish);
    app.activeContextPublish = queued.catch(() => {});
    return queued;
  };
  const selectRun = new Function(
    "app", "client", "clearPendingCursorSave", "renderRuns", "renderHeader", "renderMessages",
    "renderInspector", "attachSession", "patchEnvelope", "queueActiveContextPublish", "el",
    `${html.slice(start, end)}; return selectRun;`,
  )(
    app,
    { run: async (id: string) => ({ id, session_id: `session-${id}`, project_id: `project-${id}`, goal: id, status: "running" }) },
    () => {}, () => {}, () => {}, () => {}, async () => true,
    (id: string) => attachments.push(id), async () => {}, queueActiveContextPublish,
    (id: string) => id === "prompt" ? { value: "draft" } : { textContent: "" },
  ) as (id: string) => Promise<void>;

  const selectingA = selectRun("run-a");
  await aEntered;
  const selectingB = selectRun("run-b");
  releaseA();
  await Promise.all([selectingA, selectingB]);

  assert.deepEqual(publications, ["run-a", "run-b"]);
  assert.deepEqual(attachments, ["run-b"]);
  assert.equal(app.currentRunId, "run-b");
});

test("cockpit drops buffered attach events after abort and run selection change", async () => {
  const start = html.indexOf("function attachmentIsCurrent");
  const end = html.indexOf("async function sendPrompt", start);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const cursors: unknown[] = [];
  const transcriptRestores: unknown[] = [];
  const patches: unknown[] = [];
  const app = {
    runSelectionGeneration: 1,
    currentRunId: "run-a",
    currentSessionId: "session-a",
    envelope: { transcript_epoch: "epoch-a" },
    streamAbort: null,
    snapshotParts: new Map(),
    sessionEventKeys: new Map(),
  };
  const attach = new Function(
    "app", "client", "actor", "patchEnvelope", "restoreTranscriptSnapshot", "scheduleCursorSave",
    "deduplicatedLiveText", "addEntry", "notify", "AbortController",
    `${html.slice(start, end)}; return attachSession;`,
  )(
    app,
    {
      async *attachSession() {
        await blocked;
        yield { id: "41", type: "transcript", data: { messages: [{ id: "old" }] } };
      },
    },
    "test",
    async (change: unknown) => { patches.push(change); },
    (...args: unknown[]) => transcriptRestores.push(args),
    (...args: unknown[]) => cursors.push(args),
    () => "",
    () => {},
    () => {},
    AbortController,
  ) as (runId: string, sessionId: string, generation: number) => void;

  attach("run-a", "session-a", 1);
  const oldController = app.streamAbort as unknown as AbortController;
  app.runSelectionGeneration = 2;
  app.currentRunId = "run-b";
  app.currentSessionId = "session-b";
  oldController.abort();
  release();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(transcriptRestores, []);
  assert.deepEqual(cursors, []);
  assert.deepEqual(patches, []);
});

test("cockpit reconnects session attach from the last consumed event without duplicate tokens", async () => {
  const start = html.indexOf("function attachmentIsCurrent");
  const end = html.indexOf("async function sendPrompt", start);
  const calls: Array<string | undefined> = [];
  const tokens: string[] = [];
  const cursors: string[] = [];
  const notices: unknown[] = [];
  const seen = new Set<string>();
  const app: any = {
    runSelectionGeneration: 1, currentRunId: "run-a", currentSessionId: "session-a",
    currentRun: { id: "run-a" }, streamAbort: null,
    envelope: { active: { run_id: "run-a", session_id: "session-a" }, transcript_epoch: "epoch-a", last_event_id: "7" },
    snapshotParts: new Map([["run-a", new Map()]]), sessionEventKeys: new Map(),
  };
  let streamCall = 0;
  const client = {
    async *attachSession(_session: string, _actor: string, options: { lastEventId?: string }) {
      calls.push(options.lastEventId); streamCall += 1;
      yield { type: "hello", data: { stream_epoch: "epoch-a" } };
      if (streamCall === 1) {
        yield { id: "8", type: "token", data: { channel: "text", data: { delta: "A" } } };
        throw new Error("transient");
      }
      yield { id: "8", type: "token", data: { channel: "text", data: { delta: "duplicate" } } };
      yield { id: "9", type: "token", data: { channel: "text", data: { delta: "B" } } };
      app.streamAbort.abort();
    },
    async experience() { return app.envelope; },
    async run() { return { id: "run-a" }; },
  };
  const attach = new Function(
    "app", "client", "actor", "patchEnvelope", "restoreEnvelope", "renderRuns", "renderHeader",
    "restoreTranscriptSnapshot", "scheduleCursorSave", "deduplicatedLiveText", "sessionEventIsDuplicate",
    "addEntry", "notify", "abortableDelay", "experienceRetryDelay", "envelopeId", "AbortController",
    `${html.slice(start, end)}; return attachSession;`,
  )(
    app, client, "test", async () => {}, async () => {}, () => {}, () => {}, () => {},
    (id: string) => cursors.push(id), (_run: string, data: any) => data.delta,
    (_run: string, event: any) => event.id ? (seen.has(event.id) ? true : (seen.add(event.id), false)) : false,
    (_run: string, entry: any) => tokens.push(entry.text), (error: unknown) => notices.push(error),
    async () => {}, () => 0, "primary", AbortController,
  ) as (runId: string, sessionId: string, generation: number) => void;
  attach("run-a", "session-a", 1);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(calls, ["7", "8"]);
  assert.deepEqual(tokens, ["A", "B"]);
  assert.deepEqual(cursors, ["8", "9"]);
  assert.equal(notices.length, 1);
});

test("cockpit discards a stale attach epoch and reconnects fresh for a durable transcript", async () => {
  const start = html.indexOf("function attachmentIsCurrent");
  const end = html.indexOf("async function sendPrompt", start);
  const calls: Array<string | undefined> = [];
  const snapshots: unknown[] = [];
  const patches: Array<Record<string, unknown>> = [];
  const app: any = {
    runSelectionGeneration: 1, currentRunId: "run-a", currentSessionId: "session-a", currentRun: { id: "run-a" }, streamAbort: null,
    envelope: { active: { run_id: "run-a", session_id: "session-a" }, transcript_epoch: "old", last_event_id: "7" },
    snapshotParts: new Map([["run-a", new Map()]]), sessionEventKeys: new Map(), transcripts: new Map(),
  };
  let streamCall = 0;
  const attach = new Function(
    "app", "client", "actor", "patchEnvelope", "restoreEnvelope", "renderRuns", "renderHeader",
    "restoreTranscriptSnapshot", "scheduleCursorSave", "deduplicatedLiveText", "sessionEventIsDuplicate",
    "addEntry", "notify", "abortableDelay", "experienceRetryDelay", "envelopeId", "AbortController",
    `${html.slice(start, end)}; return attachSession;`,
  )(
    app, {
      async *attachSession(_session: string, _actor: string, options: { lastEventId?: string }) {
        calls.push(options.lastEventId); streamCall += 1;
        yield { type: "hello", data: { stream_epoch: "new" } };
        if (streamCall === 2) { yield { id: "11", type: "transcript", data: { messages: ["durable"] } }; app.streamAbort.abort(); }
      },
    }, "test",
    async (patch: Record<string, unknown>) => { patches.push(patch); app.envelope = { ...app.envelope, ...patch }; },
    async () => {}, () => {}, () => {}, (_run: string, messages: unknown) => snapshots.push(messages),
    () => {}, () => "", () => false, () => {}, () => {}, async () => {}, () => 0, "primary", AbortController,
  ) as (runId: string, sessionId: string, generation: number) => void;
  attach("run-a", "session-a", 1);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(calls, ["7", undefined]);
  assert.deepEqual(patches, [{ transcript_epoch: "new", transcript_cursor: 0, last_event_id: null }]);
  assert.deepEqual(snapshots, [["durable"]]);
});

test("cockpit artifact restoration aborts and discards stale run completions", async () => {
  const start = html.indexOf("async function restoreEnvelope");
  const end = html.indexOf("function experienceRetryDelay", start);
  let resolveArtifact!: (value: string) => void;
  const artifact = new Promise<string>((resolve) => { resolveArtifact = resolve; });
  let artifactSignal: AbortSignal | undefined;
  const entries: unknown[] = [];
  const app = {
    envelope: null, restoringEnvelope: false, modelRoute: {}, draftBase: null, draftLocalValue: "", draftDiverged: false,
    currentRunId: "run-a", currentRun: { id: "run-a" }, state: { runs: [{ id: "run-a" }] },
    restoredArtifactId: null, artifactAbort: null, runSelectionGeneration: 4,
  };
  const restore = new Function(
    "app", "client", "document", "el", "selectRun", "startNewTask", "renderModelSettings", "addEntry", "shortId", "AbortController",
    `${html.slice(start, end)}; return restoreEnvelope;`,
  )(
    app, { artifactById: (_id: string, signal: AbortSignal) => { artifactSignal = signal; return artifact; } },
    { activeElement: null }, () => ({ value: "" }), async () => {}, () => {}, () => {}, (...args: unknown[]) => entries.push(args), (id: string) => id, AbortController,
  ) as (envelope: Record<string, any>, options?: { signal?: AbortSignal }) => Promise<boolean>;
  const restoring = restore({
    model_route: {}, active: { run_id: "run-a" }, selected_view: "artifact", selected_artifact_id: "artifact-a", composer_draft: "",
  });
  app.runSelectionGeneration = 5; app.currentRunId = "run-b";
  resolveArtifact("stale-content");
  assert.equal(await restoring, false);
  assert.ok(artifactSignal instanceof AbortSignal);
  assert.deepEqual(entries, []);
  assert.equal(app.restoredArtifactId, null);
});

test("cockpit teardown aborts streams and sends authenticated keepalive handoff revocation", async () => {
  const start = html.indexOf("function bestEffortRevokeActiveHandoff");
  const end = html.indexOf('el("shareHandoff")', start);
  const calls: Array<{ url: string; options: Record<string, any> }> = [];
  let aborts = 0;
  const app: any = {
    activeHandoffId: "handoff-a", activeHandoffLink: "private", streamAbort: { abort: () => { aborts += 1; } },
    envelopeAbort: { abort: () => { aborts += 1; } }, artifactAbort: { abort: () => { aborts += 1; } },
    surfaceAbort: { abort: () => { aborts += 1; } },
  };
  const helpers = new Function("app", "token", "clearPendingCursorSave", "globalThis", `${html.slice(start, end)}; return { bestEffortRevokeActiveHandoff, teardownCockpit };`)(
    app, () => "gateway-token", () => {}, globalThis,
  ) as { bestEffortRevokeActiveHandoff: (fetchImpl: Function) => Promise<unknown>; teardownCockpit: () => void };
  await helpers.bestEffortRevokeActiveHandoff(async (url: string, options: Record<string, any>) => { calls.push({ url, options }); return {}; });
  assert.equal(calls[0]?.url, "/api/handoffs/handoff-a");
  assert.equal(calls[0]?.options.method, "DELETE");
  assert.equal(calls[0]?.options.headers.authorization, "Bearer gateway-token");
  assert.equal(calls[0]?.options.keepalive, true);
  assert.equal(app.activeHandoffId, null);
  app.activeHandoffId = null;
  helpers.teardownCockpit();
  assert.equal(aborts, 4);
  assert.match(html, /window\.addEventListener\("pagehide", teardownCockpit\)/);
  assert.match(html, /window\.addEventListener\("beforeunload", teardownCockpit\)/);
});

test("cockpit reconnects the experience watch with capped delay and a fresh restore", async () => {
  const start = html.indexOf("function experienceRetryDelay");
  const end = html.indexOf("async function initializeExperience", start);
  const controller = new AbortController();
  let watchCalls = 0;
  const restored: number[] = [];
  const notices: unknown[] = [];
  const app = { envelope: { revision: 1 } };
  const helpers = new Function(
    "app", "client", "envelopeId", "restoreEnvelope", "notify", "setTimeout", "clearTimeout",
    `${html.slice(start, end)}; return { experienceRetryDelay, watchExperienceWithReconnect };`,
  )(
    app,
    {
      watchExperience() {
        watchCalls += 1;
        if (watchCalls === 1) return (async function* () { throw new Error("transient"); })();
        return (async function* () {
          yield { type: "experience", data: { revision: 3 } };
          controller.abort();
        })();
      },
      async experience() { return { revision: 2 }; },
    },
    "primary",
    async (envelope: { revision: number }) => { app.envelope = envelope; restored.push(envelope.revision); },
    (error: unknown) => notices.push(error),
    setTimeout,
    clearTimeout,
  ) as {
    experienceRetryDelay: (attempt: number) => number;
    watchExperienceWithReconnect: (controller: AbortController) => Promise<void>;
  };

  assert.equal(helpers.experienceRetryDelay(0), 250);
  assert.equal(helpers.experienceRetryDelay(20), 4000);
  await helpers.watchExperienceWithReconnect(controller);
  assert.equal(watchCalls, 2);
  assert.deepEqual(restored, [2, 3]);
  assert.equal(notices.length, 1);
});
