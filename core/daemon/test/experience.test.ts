import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const runtimeRoot = mkdtempSync(join(tmpdir(), "floyd-experience-test-"));
process.env.FLOYD_RUNTIME_ROOT = runtimeRoot;
mkdirSync(join(runtimeRoot, "core"), { recursive: true, mode: 0o700 });

const { openDb } = await import("../src/db.ts");
const {
  ExperienceConflictError,
  ExperienceValidationError,
  ensureExperienceEnvelope,
  getExperienceEnvelope,
  negotiateAndRegisterSurface,
  negotiateExperience,
  synchronizePendingInteractions,
  updateExperienceEnvelope,
} = await import("../src/experience.ts");

const db = openDb(join(runtimeRoot, "core", "experience.db"));
db.exec(`CREATE TABLE connected_app_profiles (id TEXT PRIMARY KEY)`);
db.prepare(`INSERT INTO connected_app_profiles (id) VALUES ('app-a'), ('app-b')`).run();
db.prepare(
  `INSERT INTO projects (id, name, root_path, repo_path, test_command, created_at)
   VALUES ('prj_a', 'project-a', '/tmp/a', '/tmp/a', 'true', '2026-07-14T00:00:00.000Z'),
          ('prj_b', 'project-b', '/tmp/b', '/tmp/b', 'true', '2026-07-14T00:00:00.000Z')`,
).run();
db.prepare(
  `INSERT INTO sessions (id, project_id, title, created_at)
   VALUES ('ses_a', 'prj_a', 'a', '2026-07-14T00:00:00.000Z'),
          ('ses_b', 'prj_b', 'b', '2026-07-14T00:00:00.000Z')`,
).run();
db.prepare(
  `INSERT INTO runs (id, session_id, project_id, goal, status, created_at, updated_at)
   VALUES ('run_a', 'ses_a', 'prj_a', 'a', 'running', '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:00.000Z'),
          ('run_a2', 'ses_a', 'prj_a', 'a2', 'running', '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:00.000Z'),
          ('run_b', 'ses_b', 'prj_b', 'b', 'running', '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:00.000Z')`,
).run();
db.prepare(
  `INSERT INTO artifacts (id, mime, bytes, label, created_at)
   VALUES ('artifact-a', 'text/plain', 4, 'a', '2026-07-14T00:00:00.000Z')`,
).run();
db.prepare(`INSERT INTO run_artifacts (run_id, artifact_id, role) VALUES ('run_a', 'artifact-a', 'diff')`).run();
db.prepare(
  `INSERT INTO provider_profiles
   (id, vendor, billing_class, plan_name, region, credential_ref, endpoint_class, model_allowlist_json, approved, fallback_policy)
   VALUES ('profile-a', 'opencode', 'subscription', 'a', 'global', 'keychain:profile-a', 'gateway', '[]', 1, 'fail_closed')`,
).run();

test("creates and reads the deterministic default envelope with audit evidence", () => {
  assert.equal(getExperienceEnvelope(db), null);
  const envelope = ensureExperienceEnvelope(db);
  assert.equal(envelope.id, "primary");
  assert.equal(envelope.schema_version, "1.0.0");
  assert.equal(envelope.revision, 0);
  assert.deepEqual(envelope.active, { project_id: null, session_id: null, run_id: null });
  assert.deepEqual(envelope.connected_app_ids, []);
  assert.deepEqual(envelope.surfaces, {});
  assert.deepEqual(getExperienceEnvelope(db), envelope);
  const event = db.prepare(`SELECT type, payload_json FROM evidence_events WHERE type = 'experience.envelope.created'`).get() as { type: string; payload_json: string };
  assert.equal(event.type, "experience.envelope.created");
  assert.equal(JSON.parse(event.payload_json).envelope_id, "primary");
});

test("hydrates legacy envelopes with an empty connected-app selection", () => {
  const legacy = ensureExperienceEnvelope(db, "legacy-connected-apps");
  const payload = { ...legacy } as Partial<typeof legacy>;
  delete payload.connected_app_ids;
  db.prepare(`UPDATE experience_envelopes SET payload_json = ? WHERE id = ?`)
    .run(JSON.stringify(payload), legacy.id);

  assert.deepEqual(getExperienceEnvelope(db, legacy.id)?.connected_app_ids, []);
});

test("validates project, session, and run as one referentially consistent context", () => {
  assert.throws(() => updateExperienceEnvelope(db, "primary", {
    expected_revision: 0,
    active: { project_id: "prj_a", session_id: "ses_b", run_id: null },
  }), (error: unknown) => error instanceof ExperienceValidationError && /does not belong/.test(error.message));

  assert.throws(() => updateExperienceEnvelope(db, "primary", {
    expected_revision: 0,
    active: { project_id: "prj_a", session_id: "ses_a", run_id: "run_b" },
  }), (error: unknown) => error instanceof ExperienceValidationError && /does not belong/.test(error.message));

  const envelope = updateExperienceEnvelope(db, "primary", {
    expected_revision: 0,
    active: { project_id: "prj_a", session_id: "ses_a", run_id: "run_a" },
  });
  assert.deepEqual(envelope.active, { project_id: "prj_a", session_id: "ses_a", run_id: "run_a" });
});

test("merges independent state, registers surfaces, and rejects stale revisions", () => {
  const before = getExperienceEnvelope(db)!;
  const desktop = updateExperienceEnvelope(db, "primary", {
    expected_revision: before.revision,
    model_route: {
      provider: "opencode-go",
      model: "kimi",
      base_url: "https://opencode.ai/zen/go/v1",
      provider_profile_id: "profile-a",
      credential_ref: "keychain:profile-a",
    },
    transcript_cursor: 8,
    last_event_id: "evt-8",
    composer_draft: "finish the portable handoff",
    selected_artifact_id: "artifact-a",
    selected_view: "diff",
    surface: {
      surface_id: "desktop",
      sdk_version: "0.1.0",
      capabilities: ["artifact", "chat", "chat"],
      transcript_cursor: 8,
      last_event_id: "evt-8",
    },
    device_id: "device-a",
  });
  assert.deepEqual(desktop.surfaces.desktop!.capabilities, ["artifact", "chat"]);

  const ide = updateExperienceEnvelope(db, "primary", {
    expected_revision: desktop.revision,
    model_route: { model: "kimi-k2" },
    surface: {
      surface_id: "ide",
      sdk_version: "0.2.0",
      capabilities: ["editor"],
      transcript_cursor: 0,
      last_event_id: null,
    },
  });
  assert.equal(ide.model_route.provider, "opencode-go");
  assert.equal(ide.model_route.model, "kimi-k2");
  assert.equal(ide.composer_draft, "finish the portable handoff");
  assert.deepEqual(Object.keys(ide.surfaces).sort(), ["desktop", "ide"]);

  assert.throws(() => updateExperienceEnvelope(db, "primary", {
    expected_revision: desktop.revision,
    selected_view: "stale-write",
  }), (error: unknown) => error instanceof ExperienceConflictError && error.statusCode === 409);
});

test("resets transcript cursors when the active session changes", () => {
  const before = getExperienceEnvelope(db)!;
  const switched = updateExperienceEnvelope(db, "primary", {
    expected_revision: before.revision,
    active: { project_id: "prj_b", session_id: "ses_b", run_id: "run_b" },
  });
  assert.equal(switched.transcript_cursor, 0);
  assert.equal(switched.surfaces.desktop!.transcript_cursor, 0);
  const advanced = updateExperienceEnvelope(db, "primary", {
    expected_revision: switched.revision,
    transcript_cursor: 100,
    last_event_id: "100",
  });
  assert.equal(advanced.transcript_cursor, 100);
  const restarted = updateExperienceEnvelope(db, "primary", {
    expected_revision: advanced.revision,
    transcript_epoch: "core-epoch-2",
  });
  assert.equal(restarted.transcript_cursor, 0);
  assert.equal(restarted.last_event_id, null);
  assert.equal(restarted.surfaces.desktop!.transcript_cursor, 0);
  assert.equal(restarted.surfaces.desktop!.transcript_epoch, "core-epoch-2");
  updateExperienceEnvelope(db, "primary", {
    expected_revision: restarted.revision,
    transcript_cursor: 100,
    last_event_id: "100",
  });
});

test("clears a selected artifact when the active run changes within one session", () => {
  const before = getExperienceEnvelope(db)!;
  const onFirstRun = updateExperienceEnvelope(db, "primary", {
    expected_revision: before.revision,
    active: { project_id: "prj_a", session_id: "ses_a", run_id: "run_a" },
    transcript_cursor: 12,
    last_event_id: "12",
    pending_questions: [{ id: "run-a-question" }],
    pending_permissions: [{ id: "run-a-permission" }],
    selected_artifact_id: "artifact-a",
  });
  const onSecondRun = updateExperienceEnvelope(db, "primary", {
    expected_revision: onFirstRun.revision,
    active: { run_id: "run_a2" },
  });
  assert.equal(onSecondRun.selected_artifact_id, null);
  assert.equal(onSecondRun.transcript_cursor, 0);
  assert.equal(onSecondRun.last_event_id, null);
  assert.deepEqual(onSecondRun.pending_questions, []);
  assert.deepEqual(onSecondRun.pending_permissions, []);
  updateExperienceEnvelope(db, "primary", {
    expected_revision: onSecondRun.revision,
    active: { project_id: "prj_b", session_id: "ses_b", run_id: "run_b" },
  });
});

test("synchronizes pending asks and keeps credential values out of storage and evidence", () => {
  const before = getExperienceEnvelope(db)!;
  const updated = synchronizePendingInteractions(db, "primary", before.revision,
    [{ id: "question-1", prompt: "Choose a branch" }],
    [{ id: "permission-1", kind: "write" }],
  );
  assert.equal(updated.pending_questions.length, 1);
  assert.equal(updated.pending_permissions.length, 1);

  assert.throws(() => updateExperienceEnvelope(db, "primary", {
    expected_revision: updated.revision,
    model_route: { credential_ref: "sk-live-secret-value" },
  }), (error: unknown) => error instanceof ExperienceValidationError && /broker reference/.test(error.message));

  assert.throws(() => updateExperienceEnvelope(db, "primary", {
    expected_revision: updated.revision,
    model_route: { api_key: "sk-live-secret-value" },
  } as never), (error: unknown) => error instanceof ExperienceValidationError && /not supported/.test(error.message));

  assert.throws(() => synchronizePendingInteractions(db, "primary", updated.revision,
    [{ api_key: "sk-live-secret-value" }], [],
  ), (error: unknown) => error instanceof ExperienceValidationError && /may not persist credential/.test(error.message));

  const stored = db.prepare(`SELECT payload_json FROM experience_envelopes WHERE id = 'primary'`).get() as { payload_json: string };
  const evidence = db.prepare(`SELECT group_concat(payload_json, '') AS bodies FROM evidence_events`).get() as { bodies: string };
  assert.equal(stored.payload_json.includes("sk-live-secret-value"), false);
  assert.equal(evidence.bodies.includes("sk-live-secret-value"), false);
});

test("negotiates the SDK/envelope contract and registers only accepted surfaces", () => {
  const tooOld = negotiateExperience({
    surface_id: "legacy",
    sdk_version: "0.0.9",
    supported_envelope_versions: ["1.0.0"],
    capabilities: ["chat"],
  });
  assert.equal(tooOld.accepted, false);
  assert.match(tooOld.reason ?? "", /older than minimum/);

  const incompatible = negotiateAndRegisterSurface(db, "primary", {
    surface_id: "future",
    sdk_version: "1.0.0",
    supported_envelope_versions: ["2.0.0"],
    capabilities: ["chat"],
  }, getExperienceEnvelope(db)!.revision);
  assert.equal(incompatible.negotiation.accepted, false);
  assert.equal(incompatible.envelope.surfaces.future, undefined);

  const current = getExperienceEnvelope(db)!;
  const accepted = negotiateAndRegisterSurface(db, "primary", {
    surface_id: "terminal-one",
    sdk_version: "0.1.0",
    supported_envelope_versions: ["1.0.0"],
    capabilities: ["pty", "chat", "pty"],
  }, current.revision, "device-terminal");
  assert.equal(accepted.negotiation.accepted, true);
  assert.deepEqual(accepted.envelope.surfaces["terminal-one"]!.capabilities, ["chat", "pty"]);
  assert.equal(accepted.envelope.updated_by_device_id, "device-terminal");
  const advanced = updateExperienceEnvelope(db, "primary", {
    expected_revision: accepted.envelope.revision,
    surface: {
      surface_id: "terminal-one",
      sdk_version: "0.1.0",
      capabilities: ["chat", "pty"],
      transcript_cursor: 21,
      last_event_id: "event-21",
    },
  });
  const reattached = negotiateAndRegisterSurface(db, "primary", {
    surface_id: "terminal-one",
    sdk_version: "0.2.0",
    supported_envelope_versions: ["1.0.0"],
    capabilities: ["chat", "pty", "artifact"],
  }, advanced.revision, "device-terminal");
  assert.equal(reattached.envelope.surfaces["terminal-one"]!.transcript_cursor, 21);
  assert.equal(reattached.envelope.surfaces["terminal-one"]!.last_event_id, "event-21");
  const rejected = db.prepare(`SELECT COUNT(*) AS count FROM evidence_events WHERE type = 'experience.negotiation.rejected'`).get() as { count: number };
  const successful = db.prepare(`SELECT COUNT(*) AS count FROM evidence_events WHERE type = 'experience.negotiation.accepted'`).get() as { count: number };
  assert.equal(rejected.count, 1);
  assert.equal(successful.count, 2);
});

test("rejects cursor regression and dangling artifact references", () => {
  const before = getExperienceEnvelope(db)!;
  const current = updateExperienceEnvelope(db, "primary", {
    expected_revision: before.revision,
    transcript_cursor: 100,
    last_event_id: "100",
  });
  assert.throws(() => updateExperienceEnvelope(db, "primary", {
    expected_revision: current.revision,
    transcript_cursor: 7,
  }), /may not move backwards/);
  assert.throws(() => updateExperienceEnvelope(db, "primary", {
    expected_revision: current.revision,
    selected_artifact_id: "missing-artifact",
  }), /does not belong/);
  assert.throws(() => updateExperienceEnvelope(db, "primary", {
    expected_revision: current.revision,
    selected_artifact_id: "artifact-a",
  }), /does not belong to active run run_b/);
  assert.throws(() => updateExperienceEnvelope(db, "primary", {
    expected_revision: current.revision,
    surface: { surface_id: "malformed" },
  } as never), (error: unknown) => error instanceof ExperienceValidationError && /surface\.sdk_version/.test(error.message));
  assert.throws(() => updateExperienceEnvelope(db, "primary", {
    expected_revision: current.revision,
    transcript_epoch: "epoch-a",
    surface: {
      surface_id: "epoch-mismatch",
      sdk_version: "1.0.0",
      capabilities: [],
      transcript_cursor: 0,
      transcript_epoch: "epoch-b",
      last_event_id: null,
    },
  }), (error: unknown) => error instanceof ExperienceValidationError && /must match/.test(error.message));
});

test("validates, canonicalizes, and preserves connected-app selections", () => {
  const before = getExperienceEnvelope(db)!;
  const selected = updateExperienceEnvelope(db, "primary", {
    expected_revision: before.revision,
    connected_app_ids: ["app-b", "app-a", "app-a"],
  });
  assert.deepEqual(selected.connected_app_ids, ["app-a", "app-b"]);

  const preserved = updateExperienceEnvelope(db, "primary", {
    expected_revision: selected.revision,
    selected_view: "connected-app-selection-preserved",
  });
  assert.deepEqual(preserved.connected_app_ids, ["app-a", "app-b"]);

  assert.throws(() => updateExperienceEnvelope(db, "primary", {
    expected_revision: preserved.revision,
    connected_app_ids: ["missing-app"],
  }), (error: unknown) => error instanceof ExperienceValidationError && /missing-app.*does not exist/.test(error.message));
  assert.deepEqual(getExperienceEnvelope(db)!.connected_app_ids, ["app-a", "app-b"]);
});
