/**
 * @floyd/contracts — canonical typed vocabulary for the Floyd ecosystem.
 * Floyd Core is the sole durable authority; every surface and engine adapter
 * speaks these shapes. Contracts precede providers (FABLE5_HANDOFF build order).
 */

// ---------- identity / lifecycle primitives ----------

export type FloydId = string; // `${prefix}_${ulid-ish}` e.g. prj_..., ses_..., run_..., job_...

export type RunStatus =
  | "created"
  | "running"
  | "waiting_review"
  | "accepted"
  | "rejected"
  | "escalated"
  | "failed"
  | "interrupted";

export type JobStatus =
  | "created"
  | "leased"
  | "running"
  | "waiting_review"
  | "succeeded"
  | "failed"
  | "interrupted"
  | "skipped_duplicate";

export type JobKind = "builder" | "reviewer";

// ---------- action envelopes (blueprint: required envelopes) ----------

export interface ActionRequest {
  id: FloydId;
  actor_id: string;
  device_id: string;
  project_id: FloydId;
  session_id: FloydId;
  run_id?: FloydId;
  job_id?: FloydId;
  capability: string;
  input: unknown;
  deadline_ms?: number;
  idempotency_key: string;
  requested_permissions: string[];
  correlation_id: string;
}

export type ObservationPhase = "queued" | "leased" | "running" | "waiting_review" | "terminal";
export type ObservationStatus = "success" | "warning" | "error";

export interface ActionObservation {
  phase: ObservationPhase;
  status: ObservationStatus;
  summary: string;
  next_actions: string[];
  artifacts: string[]; // artifact ids (sha256)
  evidence: string[]; // evidence event ids
  error?: { code: string; retriable: boolean; recovery: string; stop_reason?: string };
}

// ---------- durable entities ----------

export interface Project {
  id: FloydId;
  name: string;
  root_path: string;
  repo_path: string;
  test_command: string | null;
  created_at: string;
}

export interface Session {
  id: FloydId;
  project_id: FloydId;
  title: string;
  created_at: string;
}

export interface Run {
  id: FloydId;
  session_id: FloydId;
  project_id: FloydId;
  goal: string;
  status: RunStatus;
  created_at: string;
  updated_at: string;
}

export interface Job {
  id: FloydId;
  run_id: FloydId;
  kind: JobKind;
  status: JobStatus;
  idempotency_key: string;
  agent_spec_id: string;
  engine_session_id: string | null;
  worktree_lease_id: FloydId | null;
  result_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface Lease {
  id: FloydId;
  resource_type: "worktree" | "pty" | "sandbox";
  resource_path: string;
  holder_job_id: FloydId;
  status: "active" | "released";
  acquired_at: string;
  released_at: string | null;
}

export interface Artifact {
  id: string; // sha256 hex — content address
  mime: string;
  bytes: number;
  label: string;
  created_at: string;
}

export interface EvidenceEvent {
  seq: number;
  id: string;
  ts: string;
  type: string;
  actor: string;
  project_id: string | null;
  session_id: string | null;
  run_id: string | null;
  job_id: string | null;
  correlation_id: string | null;
  payload: unknown;
}

export interface AgentSpec {
  id: string;
  name: string;
  role: JobKind;
  provider_profile_id: string;
  model: string;
  permission_policy: PermissionPolicy;
}

export type BillingClass = "subscription" | "payg" | "local";

export interface ProviderProfile {
  id: string;
  vendor: string;
  billing_class: BillingClass;
  plan_name: string;
  region: string;
  credential_ref: string; // broker reference — NEVER a credential value
  endpoint_class: string;
  model_allowlist: string[];
  approved: boolean;
  fallback_policy: "fail_closed";
}

// ---------- user-owned model connector authority ----------

export type ConnectorProvider = "opencode-zen" | "opencode-go" | "openai" | "anthropic";
export type ConnectorClientAuth = "none" | "client_secret_basic" | "client_secret_post";

/** Sanitized connector metadata. Credential values never cross this contract. */
export interface ConnectorProfile {
  id: string;
  displayName: string;
  provider: ConnectorProvider;
  dialect: "openai" | "anthropic";
  baseUrl: string;
  clientId: string | null;
  clientAuth: ConnectorClientAuth;
  authorizationUrl: string | null;
  tokenUrl: string | null;
  revocationUrl: string | null;
  scopes: string[];
  credentialRef: string | null;
  credentialKind: "api_key" | "oauth" | null;
  expiresAt: string | null;
  revoked: boolean;
}

export interface ConnectorProfileInput {
  id: string;
  displayName: string;
  provider: ConnectorProvider;
  baseUrl: string;
  clientId?: string;
  clientSecret?: string;
  clientAuth?: ConnectorClientAuth;
  authorizationUrl?: string;
  tokenUrl?: string;
  revocationUrl?: string;
  scopes?: string[];
}

export interface ConnectorOAuthStart {
  authorizationUrl: string;
  state: string;
  expiresAt: string;
}

// ---------- Core-owned connected application authority ----------

/** Sanitized remote MCP application metadata. OAuth secrets never cross this contract. */
export interface ConnectedAppProfile {
  id: string;
  displayName: string;
  resourceUrl: string;
  resourceMetadataUrl: string;
  issuer: string;
  authorizationUrl: string;
  tokenUrl: string;
  registrationUrl: string | null;
  revocationUrl: string | null;
  scopesSupported: string[];
  scopesRequested: string[];
  scopesGranted: string[];
  registrationMethod: "dynamic" | "pre_registered";
  clientAuthMethod: "none" | "client_secret_post";
  expiresAt: string | null;
  status: "discovered" | "authorization_required" | "connected" | "refreshing" | "reauth_required" | "revocation_pending" | "revoked";
}

export interface ConnectedAppProfileInput {
  id: string;
  displayName: string;
  resourceUrl: string;
  scopes?: string[];
}

export interface ConnectedAppOAuthStart {
  connectedAppId: string;
  authorizationUrl: string;
  expiresAt: string;
}

/** Browser-safe invocation input. Core supplies OAuth and MCP session state. */
export interface ConnectedAppInvokeRequest {
  method: string;
  params?: unknown;
}

/** Normalized JSON-RPC messages returned by a Core-owned MCP transport. */
export interface ConnectedAppInvokeResponse {
  connectedAppId: string;
  status: number;
  messages: unknown[];
}

export interface RouteReceipt {
  provider: string;
  model: string;
  billing_class: BillingClass;
  plan_name: string;
  region: string;
  project_id: FloydId;
  run_id: FloydId;
  job_id: FloydId;
  issued_at: string;
}

// ---------- portable cross-surface experience ----------

/** Independently versioned from package releases so old surfaces can negotiate. */
export const FLOYD_EXPERIENCE_VERSION = "1.0.0" as const;
export const FLOYD_SDK_PROTOCOL_VERSION = "1.0.0" as const;

export interface ExperienceActiveContext {
  project_id: FloydId | null;
  session_id: FloydId | null;
  run_id: FloydId | null;
}

/** Credential values are forbidden here; only a Core-owned reference may persist. */
export interface ExperienceModelRoute {
  provider: string | null;
  model: string | null;
  base_url: string | null;
  provider_profile_id: string | null;
  credential_ref: string | null;
}

export interface SurfaceExperienceState {
  surface_id: string;
  sdk_version: string;
  envelope_version: string;
  capabilities: string[];
  transcript_cursor: number;
  transcript_epoch: string | null;
  last_event_id: string | null;
  last_seen_at: string;
}

export interface ExperienceEnvelope {
  id: string;
  schema_version: typeof FLOYD_EXPERIENCE_VERSION;
  revision: number;
  active: ExperienceActiveContext;
  model_route: ExperienceModelRoute;
  /** Core-owned connected applications selected for this portable experience. */
  connected_app_ids: string[];
  transcript_cursor: number;
  transcript_epoch: string | null;
  last_event_id: string | null;
  pending_questions: unknown[];
  pending_permissions: unknown[];
  composer_draft: string;
  selected_artifact_id: string | null;
  selected_view: string;
  surfaces: Record<string, SurfaceExperienceState>;
  updated_at: string;
  updated_by_device_id: string | null;
}

export interface ExperienceEnvelopePatch {
  expected_revision: number;
  active?: Partial<ExperienceActiveContext>;
  model_route?: Partial<ExperienceModelRoute>;
  connected_app_ids?: string[];
  transcript_cursor?: number;
  transcript_epoch?: string | null;
  last_event_id?: string | null;
  composer_draft?: string;
  selected_artifact_id?: string | null;
  selected_view?: string;
  surface?: Omit<SurfaceExperienceState, "last_seen_at" | "envelope_version" | "transcript_epoch"> & {
    envelope_version?: string;
    transcript_epoch?: string | null;
  };
  device_id?: string | null;
}

export interface ExperienceNegotiationRequest {
  surface_id: string;
  sdk_version: string;
  supported_envelope_versions: string[];
  capabilities: string[];
}

export interface ExperienceNegotiationResult {
  accepted: boolean;
  envelope_version: string | null;
  core_protocol_version: typeof FLOYD_SDK_PROTOCOL_VERSION;
  minimum_sdk_version: string;
  reason?: string;
}

export interface ExperienceDeviceEnrollment {
  device_id: string;
  /** Returned exactly once. Surfaces must move it to platform-secure storage. */
  secret: string;
  created_at: string;
  key_id: string;
}

export const FLOYD_DEVICE_SESSION_SCOPES = [
  "health:read",
  "state:read",
  "experience:read",
  "experience:write",
  "session:read",
  "session:steer",
  "session:answer",
  "session:permission",
  "run:read",
  "artifact:read",
  "evidence:read",
  /** Read state from a connected app selected in this session's immutable handoff resources. */
  "connected_app:read",
  /** Invoke a connected app selected in this session's immutable handoff resources. */
  "connected_app:invoke",
  /** Grants an authenticated remote device the same host-app authority as the local developer UI. */
  "surface:access",
] as const;

export type ExperienceDeviceSessionScope = typeof FLOYD_DEVICE_SESSION_SCOPES[number];

export interface ExperienceDeviceSessionResources {
  envelope_ids: string[];
  project_ids: string[];
  session_ids: string[];
  run_ids: string[];
  artifact_ids: string[];
  connected_app_ids: string[];
}

export interface ExperienceDeviceSession {
  session_id: string;
  device_id: string;
  /** Returned exactly once. Store as a short-lived platform credential. */
  token: string;
  scopes: ExperienceDeviceSessionScope[];
  resources: ExperienceDeviceSessionResources;
  created_at: string;
  expires_at: string;
}

export interface AuthenticatedExperienceDevice {
  device_id: string;
  metadata: Record<string, unknown>;
  authenticated_at: string;
  session: ExperienceDeviceSession;
}

export interface ExperienceHandoffIssue {
  handoff_id: string;
  token: string;
  envelope_id: string;
  envelope_revision: number;
  expires_at: string;
  deep_link: string;
  /** Locally rendered QR image. Contains the deep link as geometry only. */
  qr_svg: string;
  qr_content_type: "image/svg+xml";
}

export interface ExperienceHandoffConsumption {
  handoff_id: string;
  envelope_id: string;
  envelope_revision: number;
  created_by_device_id: string | null;
  consumed_at: string;
  envelope: ExperienceEnvelope;
  session: ExperienceDeviceSession;
}

export interface PairedExperienceHandoff {
  handoff_id: string;
  envelope_id: string;
  envelope_revision: number;
  consumed_at: string;
  envelope: ExperienceEnvelope;
  /** Session token is held only in Core's HttpOnly cookie. */
  session: Omit<ExperienceDeviceSession, "token">;
}

// ---------- permission gating ----------

export interface PermissionPolicy {
  /** permission kinds allowed when the target stays inside the leased worktree */
  allow_in_worktree: string[];
  /** permission kinds always rejected */
  deny: string[];
}

export interface PolicyDecision {
  request_id: string;
  session_id: string;
  kind: string;
  decision: "once" | "reject";
  reason: string;
  decided_at: string;
}

// ---------- engine adapter boundary ----------

export interface EngineSessionRef {
  engine: "opencode";
  engine_session_id: string;
  directory: string;
}

export const FLOYD_ID_PREFIXES = {
  project: "prj",
  session: "ses",
  run: "run",
  job: "job",
  lease: "lse",
  evidence: "evt",
} as const;
