import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type { Db } from "./db.ts";
import type { OpenCodeEngine } from "./engine.ts";
import { newId, nowIso, PATHS } from "./config.ts";
import { appendEvidence } from "./evidence.ts";
import { putArtifact, linkRunArtifact, getArtifact } from "./artifacts.ts";
import { acquireLease, releaseLease } from "./leases.ts";
import { addWorktree, removeWorktree, worktreeDiff, headSha, gitOrThrow, git } from "./git.ts";
import { putMemory, recallMemory, formatMemoryContext } from "./memory.ts";
import { loadSkill } from "./skills.ts";
import type { PermissionPolicy } from "@floyd/contracts";

const PROVIDER_ID = "zai-coding-plan";
const DEFAULT_BUILDER_IDLE_TIMEOUT_MS = 300000;

function builderIdleTimeoutMs(): number {
  const raw = process.env.FLOYD_BUILDER_IDLE_TIMEOUT_MS;
  if (!raw) return DEFAULT_BUILDER_IDLE_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 30000 || value > 900000) {
    throw new Error("FLOYD_BUILDER_IDLE_TIMEOUT_MS must be an integer from 30000 through 900000");
  }
  return value;
}

interface JobRow {
  id: string;
  run_id: string;
  kind: string;
  status: string;
  idempotency_key: string;
  agent_spec_id: string;
  engine_session_id: string | null;
  worktree_lease_id: string | null;
  result_json: string | null;
}

function getApprovedProfile(db: Db): Record<string, unknown> {
  const p = db
    .prepare(`SELECT * FROM provider_profiles WHERE id = 'glm-coding-plan' AND approved = 1`)
    .get() as Record<string, unknown> | undefined;
  if (!p) throw new Error("provider profile glm-coding-plan is not approved — fail closed, no fallback");
  return p;
}

function getAgentSpec(db: Db, id: string): { model: string; policy: PermissionPolicy; provider_profile_id: string } {
  const row = db.prepare(`SELECT * FROM agent_specs WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  if (!row) throw new Error(`agent spec ${id} missing`);
  return {
    model: String(row.model),
    policy: JSON.parse(String(row.permission_policy_json)) as PermissionPolicy,
    provider_profile_id: String(row.provider_profile_id),
  };
}

function setJob(db: Db, jobId: string, fields: Record<string, string | null>): void {
  const keys = Object.keys(fields);
  const sets = keys.map((k) => `${k} = ?`).join(", ");
  db.prepare(`UPDATE jobs SET ${sets}, updated_at = ? WHERE id = ?`).run(
    ...keys.map((k) => fields[k] ?? null),
    nowIso(),
    jobId,
  );
}

function setRun(db: Db, runId: string, status: string): void {
  db.prepare(`UPDATE runs SET status = ?, updated_at = ? WHERE id = ?`).run(status, nowIso(), runId);
}

/**
 * Permission gate: while the engine session works, poll pending permission
 * requests and decide by AgentSpec policy. Every decision is evidence.
 */
async function gatePermissions(
  db: Db,
  engine: OpenCodeEngine,
  sessionID: string,
  worktree: string | null,
  policy: PermissionPolicy,
  scope: { run_id: string; job_id: string },
  stop: { done: boolean },
): Promise<void> {
  const seen = new Set<string>();
  while (!stop.done) {
    try {
      const pending = await engine.pendingPermissions(sessionID);
      for (const req of pending) {
        const reqId = String(req.id ?? "");
        if (!reqId || seen.has(reqId)) continue;
        seen.add(reqId);
        const kind = String((req.permission as Record<string, unknown> | undefined)?.type ?? req.type ?? "unknown");
        const patterns = JSON.stringify(req).slice(0, 2000);
        let decision: "once" | "reject";
        let reason: string;
        if (policy.deny.includes(kind)) {
          decision = "reject";
          reason = `kind ${kind} denied by agent spec`;
        } else if (policy.allow_in_worktree.includes(kind)) {
          // session is directory-bound to the leased worktree; allow within it
          decision = "once";
          reason = worktree
            ? `kind ${kind} allowed inside leased worktree ${worktree}`
            : `kind ${kind} allowed by spec`;
        } else {
          // Unlisted kinds are NOT surfaced for a human decision: there is no
          // human on the launchd-managed loopback path. Reject them deterministically
          // so the run fails fast instead of hanging until waitIdle times out.
          decision = "reject";
          reason = `kind ${kind} not listed in agent spec policy — auto-rejected (no human surface available)`;
        }
        await engine.replyPermission(sessionID, reqId, decision);
        appendEvidence(db, "policy.decision", "floyd-core", { request_id: reqId, kind, decision, reason, raw: patterns }, {
          run_id: scope.run_id,
          job_id: scope.job_id,
        });
      }
    } catch {
      /* engine busy or request already answered; keep polling until stop */
    }
    await new Promise((r) => setTimeout(r, 700));
  }
}

async function runEngineTask(
  db: Db,
  engine: OpenCodeEngine,
  opts: {
    runId: string;
    jobId: string;
    directory: string;
    worktree: string | null;
    model: string;
    promptText: string;
    policy: PermissionPolicy;
    existingSessionId?: string | null;
    engineAgent?: string;
    idleTimeoutMs?: number;
  },
): Promise<{ sessionID: string; transcript: unknown }> {
  let sessionID = opts.existingSessionId ?? null;
  if (!sessionID) {
    sessionID = await engine.createSession(opts.directory, PROVIDER_ID, opts.model, opts.engineAgent);
    // persist BEFORE prompting: restart between these two steps must not re-create work
    setJob(db, opts.jobId, { engine_session_id: sessionID });
    appendEvidence(db, "engine.session.created", "floyd-core", { engine: "opencode", sessionID, directory: opts.directory }, {
      run_id: opts.runId,
      job_id: opts.jobId,
    });
    const stop = { done: false };
    const gate = gatePermissions(db, engine, sessionID, opts.worktree, opts.policy, { run_id: opts.runId, job_id: opts.jobId }, stop);
    try {
      await engine.prompt(sessionID, opts.promptText);
      appendEvidence(db, "engine.prompt.submitted", "floyd-core", { sessionID, chars: opts.promptText.length }, {
        run_id: opts.runId,
        job_id: opts.jobId,
      });
      await engine.waitIdle(sessionID, opts.idleTimeoutMs ?? 600000);
    } finally {
      stop.done = true;
      await gate.catch(() => {});
    }
  } else {
    // recovery path: session already existed. If an assistant turn ever ran we
    // only observe (never duplicate the action). If NO assistant turn exists,
    // the action never started — re-prompting is the non-duplicating recovery.
    const ran = await engine.hasAssistantTurn(sessionID);
    appendEvidence(db, "engine.session.reattached", "floyd-core", { sessionID, prior_assistant_turn: ran }, {
      run_id: opts.runId,
      job_id: opts.jobId,
    });
    const stop = { done: false };
    const gate = gatePermissions(db, engine, sessionID, opts.worktree, opts.policy, { run_id: opts.runId, job_id: opts.jobId }, stop);
    try {
      if (!ran) {
        await engine.setSessionModel(sessionID, PROVIDER_ID, opts.model);
        await engine.prompt(sessionID, opts.promptText);
        appendEvidence(db, "engine.prompt.resubmitted", "floyd-core", { sessionID, reason: "no prior assistant turn — action never started" }, {
          run_id: opts.runId,
          job_id: opts.jobId,
        });
      }
      await engine.waitIdle(sessionID, opts.idleTimeoutMs ?? 600000);
    } finally {
      stop.done = true;
      await gate.catch(() => {});
    }
  }
  const transcript = await engine.messages(sessionID);
  return { sessionID, transcript };
}

export interface SubmitResult {
  run_id: string;
  duplicate: boolean;
}

/** Parse `@skill:name` or `@skill:name@version` requests from a goal string. */
export function parseSkillRequests(goal: string): Array<{ name: string; version?: string }> {
  const out: Array<{ name: string; version?: string }> = [];
  const re = /@skill:([a-z0-9-]+)(?:@(\d+\.\d+\.\d+))?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(goal)) !== null) out.push({ name: m[1]!, version: m[2] });
  return out;
}

/** Create (or find) a run for a goal. Idempotent on (project, goal) via job idempotency keys. */
export function createRun(db: Db, projectId: string, goal: string): SubmitResult {
  const project = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(projectId) as Record<string, unknown> | undefined;
  if (!project) throw new Error(`unknown project ${projectId}`);
  const idem = createHash("sha256").update(`builder|${projectId}|${goal}`).digest("hex");
  const existing = db.prepare(`SELECT * FROM jobs WHERE idempotency_key = ?`).get(idem) as unknown as JobRow | undefined;
  if (existing) {
    appendEvidence(db, "run.duplicate_submission", "floyd-core", { idempotency_key: idem, existing_run: existing.run_id }, {
      run_id: existing.run_id,
      project_id: projectId,
    });
    return { run_id: existing.run_id, duplicate: true };
  }
  let session = db.prepare(`SELECT * FROM sessions WHERE project_id = ? ORDER BY created_at LIMIT 1`).get(projectId) as
    | Record<string, unknown>
    | undefined;
  if (!session) {
    const sid = newId("ses");
    db.prepare(`INSERT INTO sessions (id, project_id, title, created_at) VALUES (?, ?, ?, ?)`).run(
      sid,
      projectId,
      `${String(project.name)} main session`,
      nowIso(),
    );
    session = db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(sid) as Record<string, unknown>;
  }
  const runId = newId("run");
  db.prepare(
    `INSERT INTO runs (id, session_id, project_id, goal, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'created', ?, ?)`,
  ).run(runId, String(session.id), projectId, goal, nowIso(), nowIso());
  db.prepare(
    `INSERT INTO jobs (id, run_id, kind, status, idempotency_key, agent_spec_id, created_at, updated_at)
     VALUES (?, ?, 'builder', 'created', ?, 'builder-glm', ?, ?)`,
  ).run(newId("job"), runId, idem, nowIso(), nowIso());
  appendEvidence(db, "run.created", "floyd-core", { goal }, { run_id: runId, project_id: projectId, session_id: String(session.id) });
  return { run_id: runId, duplicate: false };
}

/** Execute the golden path for a created run: builder → evidence → reviewer → waiting_review. */
export async function executeRun(db: Db, engine: OpenCodeEngine, runId: string): Promise<void> {
  const run = db.prepare(`SELECT * FROM runs WHERE id = ?`).get(runId) as Record<string, unknown> | undefined;
  if (!run) throw new Error(`unknown run ${runId}`);
  const project = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(String(run.project_id)) as Record<string, unknown>;
  const builder = db.prepare(`SELECT * FROM jobs WHERE run_id = ? AND kind = 'builder'`).get(runId) as unknown as JobRow;
  const profile = getApprovedProfile(db);
  const spec = getAgentSpec(db, "builder-glm");

  setRun(db, runId, "running");

  // ---- worktree lease ----
  const repo = String(project.repo_path);
  const baseSha = headSha(repo);
  const worktree = join(PATHS.worktrees, builder.id);
  let leaseId = builder.worktree_lease_id;
  if (!leaseId) {
    leaseId = acquireLease(db, "worktree", worktree, builder.id, { run_id: runId, project_id: String(project.id) });
    addWorktree(repo, worktree, `floyd/${builder.id}`);
    setJob(db, builder.id, { worktree_lease_id: leaseId, status: "leased" });
  }

  // ---- route receipt BEFORE first model call (hard stop requirement) ----
  const receipt = {
    provider: PROVIDER_ID,
    model: spec.model,
    billing_class: String(profile.billing_class),
    plan_name: String(profile.plan_name),
    region: String(profile.region),
    credential_ref: String(profile.credential_ref),
    project_id: String(project.id),
    run_id: runId,
    job_id: builder.id,
    issued_at: nowIso(),
  };
  const receiptArt = putArtifact(db, JSON.stringify(receipt, null, 2), "application/json", "route receipt");
  linkRunArtifact(db, runId, builder.id, receiptArt, "route_receipt");
  appendEvidence(db, "provider.route_receipt", "floyd-core", receipt, { run_id: runId, job_id: builder.id, project_id: String(project.id) });

  // ---- builder task ----
  setJob(db, builder.id, { status: "running" });
  const goal = String(run.goal);
  // Objective 3.1: recalled project memory rides into the builder prompt,
  // source-attributed and evidenced.
  const recalled = recallMemory(db, String(project.id)) as Array<{
    content: unknown; source_type: unknown; source_ref: unknown; created_at: unknown;
  }>;
  const memoryBlock = formatMemoryContext(recalled, String(project.test_command ?? "node --test"));
  appendEvidence(db, "memory.injected", "floyd-core", { items: recalled.length, chars: memoryBlock.length }, {
    run_id: runId, job_id: builder.id, project_id: String(project.id),
  });
  // Objective 3.2: load requested skills on demand into the builder context.
  const skillBlocks: string[] = [];
  for (const reqSkill of parseSkillRequests(goal)) {
    const sk = loadSkill(db, reqSkill.name, reqSkill.version);
    if (sk) {
      skillBlocks.push(`## Loaded skill: ${sk.name}@${sk.version} (digest ${sk.digest.slice(0, 12)})\n${sk.body}`);
      appendEvidence(db, "skill.loaded", "floyd-core", { name: sk.name, version: sk.version, digest: sk.digest }, {
        run_id: runId, job_id: builder.id,
      });
    } else {
      appendEvidence(db, "skill.load_failed", "floyd-core", { requested: reqSkill }, { run_id: runId, job_id: builder.id });
    }
  }
  const builderPrompt = [
    `You are the Floyd builder agent working in a leased git worktree.`,
    memoryBlock,
    ...skillBlocks,
    `Task: ${goal}`,
    `Rules: work only inside the current directory. Do not push, do not change git config, do not touch anything outside this directory.`,
    `When the change is complete, ensure the project's tests pass (${String(project.test_command ?? "node --test")}).`,
  ].join("\n");
  let sessionID: string;
  let transcript: unknown;
  try {
    const res = await runEngineTask(db, engine, {
      runId,
      jobId: builder.id,
      directory: worktree,
      worktree,
      model: spec.model,
      promptText: builderPrompt,
      policy: spec.policy,
      existingSessionId: builder.engine_session_id,
      // Interactive questions consume part of this wall-clock window. Keep it
      // bounded and operator-configurable, then abort upstream on expiration.
      idleTimeoutMs: builderIdleTimeoutMs(),
    });
    sessionID = res.sessionID;
    transcript = res.transcript;
  } catch (err) {
    const errText = err instanceof Error ? err.message : String(err);
    appendEvidence(db, "engine.builder_failed", "floyd-core", { error: errText }, { run_id: runId, job_id: builder.id });
    setJob(db, builder.id, { status: "failed", result_json: JSON.stringify({ error: errText }) });
    if (leaseId) {
      const lease = db.prepare(`SELECT * FROM leases WHERE id = ?`).get(leaseId) as Record<string, unknown> | undefined;
      if (lease && String(lease.status) === "active") {
        removeWorktree(repo, String(lease.resource_path));
        releaseLease(db, leaseId);
      }
    }
    setRun(db, runId, "failed");
    throw err;
  }

  const transcriptArt = putArtifact(db, JSON.stringify(transcript, null, 2), "application/json", "builder transcript");
  linkRunArtifact(db, runId, builder.id, transcriptArt, "transcript");

  // ---- diff + test evidence ----
  const diff = worktreeDiff(worktree, baseSha);
  const diffArt = putArtifact(db, diff || "(empty diff)", "text/x-diff", "builder diff");
  linkRunArtifact(db, runId, builder.id, diffArt, "diff");
  appendEvidence(db, "git.diff.captured", "floyd-core", { artifact: diffArt, bytes: diff.length, base: baseSha }, { run_id: runId, job_id: builder.id });

  const testCmd = String(project.test_command ?? "node --test");
  const [cmd = "node", ...args] = testCmd.split(" ");
  const test = spawnSync(cmd, args, { cwd: worktree, encoding: "utf8", timeout: 120000, env: { PATH: "/usr/bin:/bin:/opt/homebrew/bin", HOME: process.env.HOME ?? "" } });
  const testOut = `$ ${testCmd}\nexit=${test.status}\n--- stdout ---\n${test.stdout ?? ""}\n--- stderr ---\n${test.stderr ?? ""}`;
  const testArt = putArtifact(db, testOut, "text/plain", "test output");
  linkRunArtifact(db, runId, builder.id, testArt, "test_output");
  appendEvidence(db, "test.executed", "floyd-core", { command: testCmd, exit: test.status, artifact: testArt }, { run_id: runId, job_id: builder.id });

  setJob(db, builder.id, { status: "waiting_review", result_json: JSON.stringify({ sessionID, diffArt, testArt, testExit: test.status, baseSha }) });

  // ---- reviewer: separate session + separate worktree; consumes the diff ----
  const revIdem = createHash("sha256").update(`reviewer|${runId}`).digest("hex");
  let reviewer = db.prepare(`SELECT * FROM jobs WHERE idempotency_key = ?`).get(revIdem) as unknown as JobRow | undefined;
  if (!reviewer) {
    const rid = newId("job");
    db.prepare(
      `INSERT INTO jobs (id, run_id, kind, status, idempotency_key, agent_spec_id, created_at, updated_at)
       VALUES (?, ?, 'reviewer', 'created', ?, 'reviewer-glm', ?, ?)`,
    ).run(rid, runId, revIdem, nowIso(), nowIso());
    reviewer = db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(rid) as unknown as JobRow;
  }
  const reviewerSpec = getAgentSpec(db, "reviewer-glm");
  const reviewWorktree = join(PATHS.worktrees, reviewer.id);
  let reviewLease = reviewer.worktree_lease_id;
  if (!reviewLease) {
    reviewLease = acquireLease(db, "worktree", reviewWorktree, reviewer.id, { run_id: runId, project_id: String(project.id) });
    addWorktree(repo, reviewWorktree, `floyd/${reviewer.id}`);
    setJob(db, reviewer.id, { worktree_lease_id: reviewLease, status: "leased" });
  }
  setJob(db, reviewer.id, { status: "running" });
  const reviewerPrompt = [
    `You are the Floyd reviewer agent. You are in a clean read-only checkout at the same base commit.`,
    `Review the following unified diff produced by the builder for the task: "${goal}".`,
    `Also provided: test run output. Respond with a verdict line "VERDICT: approve" or "VERDICT: request_changes" followed by concise findings.`,
    `Do not edit any file. Do not run commands that modify state.`,
    ``,
    `--- DIFF ---`,
    diff.slice(0, 60000),
    ``,
    `--- TEST OUTPUT ---`,
    testOut.slice(0, 8000),
  ].join("\n");
  const revRes = await runEngineTask(db, engine, {
    runId,
    jobId: reviewer.id,
    directory: reviewWorktree,
    worktree: reviewWorktree,
    model: reviewerSpec.model,
    promptText: reviewerPrompt,
    policy: reviewerSpec.policy,
    existingSessionId: reviewer.engine_session_id,
    // engine-level enforcement: floyd-reviewer agent has write/edit/bash/patch
    // disabled (1.17.15 ignores the `permission` config field — see ADR-001;
    // tool disabling is the mechanism that actually compiles in)
    engineAgent: "floyd-reviewer",
  });
  // defense in depth: a reviewer must leave its worktree untouched
  const reviewerDiff = worktreeDiff(reviewWorktree, baseSha);
  if (reviewerDiff.trim().length > 0) {
    const mutArt = putArtifact(db, reviewerDiff, "text/x-diff", "ILLEGAL reviewer mutation");
    appendEvidence(db, "review.mutation_detected", "floyd-core", { artifact: mutArt, bytes: reviewerDiff.length }, { run_id: runId, job_id: reviewer.id });
    setJob(db, reviewer.id, { status: "failed", result_json: JSON.stringify({ error: "reviewer mutated its worktree", artifact: mutArt }) });
    throw new Error(`reviewer ${reviewer.id} mutated its worktree — review invalidated (diff ${reviewerDiff.length} bytes)`);
  }
  const reviewArt = putArtifact(db, JSON.stringify(revRes.transcript, null, 2), "application/json", "review transcript");
  linkRunArtifact(db, runId, reviewer.id, reviewArt, "review");
  appendEvidence(db, "review.completed", "floyd-core", { artifact: reviewArt, sessionID: revRes.sessionID }, { run_id: runId, job_id: reviewer.id });
  setJob(db, reviewer.id, { status: "succeeded", result_json: JSON.stringify({ sessionID: revRes.sessionID, reviewArt }) });

  setRun(db, runId, "waiting_review");
  appendEvidence(db, "run.waiting_review", "floyd-core", { note: "nothing merges without explicit user decision" }, { run_id: runId });
}

/** Explicit user gate: accept merges the builder branch; reject leaves it unmerged. */
export function decideRun(db: Db, engine: OpenCodeEngine, runId: string, action: "accept" | "reject" | "escalate", actor: string): Record<string, unknown> {
  void engine;
  const run = db.prepare(`SELECT * FROM runs WHERE id = ?`).get(runId) as Record<string, unknown> | undefined;
  if (!run) throw new Error(`unknown run ${runId}`);
  if (String(run.status) !== "waiting_review") throw new Error(`run ${runId} is ${String(run.status)}, not waiting_review`);
  const project = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(String(run.project_id)) as Record<string, unknown>;
  const builder = db.prepare(`SELECT * FROM jobs WHERE run_id = ? AND kind = 'builder'`).get(runId) as unknown as JobRow;
  const repo = String(project.repo_path);
  const branch = `floyd/${builder.id}`;
  let mergeInfo: Record<string, unknown> = {};
  if (action === "accept") {
    // merge the builder branch; worktree changes must be committed first if the engine left them dirty
    const wt = join(PATHS.worktrees, builder.id);
    const dirty = git(wt, ["status", "--porcelain"]).stdout.trim();
    if (dirty) {
      gitOrThrow(wt, ["add", "-A"]);
      gitOrThrow(wt, ["-c", "user.name=Floyd Builder", "-c", "user.email=builder@floyd.local", "commit", "-m", `floyd builder ${builder.id}: ${String(run.goal)}`]);
    }
    gitOrThrow(repo, ["merge", "--no-ff", branch, "-m", `floyd: accept run ${runId}`]);
    mergeInfo = { merged: branch, head: headSha(repo) };
    setRun(db, runId, "accepted");
    setJob(db, builder.id, { status: "succeeded" });
  } else if (action === "reject") {
    setRun(db, runId, "rejected");
    setJob(db, builder.id, { status: "failed" });
    mergeInfo = { merged: null, note: `branch ${branch} left for inspection` };
  } else {
    setRun(db, runId, "escalated");
    mergeInfo = { merged: null, note: "escalated to operator" };
  }
  // release leases and clean worktrees for terminal states
  for (const job of db.prepare(`SELECT * FROM jobs WHERE run_id = ?`).all(runId) as unknown as JobRow[]) {
    if (job.worktree_lease_id) {
      const lease = db.prepare(`SELECT * FROM leases WHERE id = ?`).get(job.worktree_lease_id) as Record<string, unknown> | undefined;
      if (lease && String(lease.status) === "active") {
        if (action === "accept" || job.kind === "reviewer") {
          removeWorktree(repo, String(lease.resource_path));
        }
        releaseLease(db, job.worktree_lease_id);
      }
    }
  }
  appendEvidence(db, "run.decision", actor, { action, ...mergeInfo }, { run_id: runId, project_id: String(project.id) });
  const diffArt = db
    .prepare(`SELECT artifact_id FROM run_artifacts WHERE run_id = ? AND role = 'diff' LIMIT 1`)
    .get(runId) as Record<string, unknown> | undefined;
  putMemory(db, {
    project_id: String(project.id),
    scope: "project",
    content: `Run "${String(run.goal).slice(0, 120)}" was ${action}ed by ${actor}${
      action === "accept" ? ` and merged as ${String(mergeInfo.head ?? "")}` : ""
    }; diff artifact ${String(diffArt?.artifact_id ?? "n/a")}.`,
    source_type: "run",
    source_ref: runId,
  });
  return { run_id: runId, action, ...mergeInfo };
}

/** Startup recovery: observe, never re-execute side effects. */
export function recoverInterrupted(db: Db): void {
  const rows = db.prepare(`SELECT id FROM jobs WHERE status IN ('running','leased')`).all() as Array<Record<string, unknown>>;
  for (const r of rows) {
    setJob(db, String(r.id), { status: "interrupted" });
    appendEvidence(db, "recovery.job_interrupted", "floyd-core", { job_id: String(r.id), note: "marked interrupted on startup; engine session preserved for observation" });
  }
  const runs = db.prepare(`SELECT id FROM runs WHERE status = 'running'`).all() as Array<Record<string, unknown>>;
  for (const r of runs) {
    setRun(db, String(r.id), "interrupted");
    appendEvidence(db, "recovery.run_interrupted", "floyd-core", {}, { run_id: String(r.id) });
  }
}

export function getRunDetail(db: Db, runId: string): Record<string, unknown> | null {
  const run = db.prepare(`SELECT * FROM runs WHERE id = ?`).get(runId) as Record<string, unknown> | undefined;
  if (!run) return null;
  const jobs = db.prepare(`SELECT * FROM jobs WHERE run_id = ? ORDER BY created_at`).all(runId);
  const arts = db
    .prepare(
      `SELECT ra.role, ra.job_id, a.* FROM run_artifacts ra JOIN artifacts a ON a.id = ra.artifact_id WHERE ra.run_id = ?`,
    )
    .all(runId);
  return { ...run, jobs, artifacts: arts };
}

export function readRunArtifact(db: Db, runId: string, role: string): string | null {
  const row = db
    .prepare(`SELECT artifact_id FROM run_artifacts WHERE run_id = ? AND role = ? LIMIT 1`)
    .get(runId, role) as Record<string, unknown> | undefined;
  if (!row) return null;
  const art = getArtifact(db, String(row.artifact_id));
  return art ? art.content.toString("utf8") : null;
}
