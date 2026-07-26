#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
MANIFEST="$ROOT/ecosystem/surfaces.json"

node --input-type=module - "$MANIFEST" <<'NODE'
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const manifest = JSON.parse(await readFile(process.argv[2], "utf8"));
const expected = ["desktop", "ide", "tui", "pty", "launcher"];
const actual = manifest.surfaces.map(surface => surface.id);
if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  throw new Error(`active surface mismatch: ${actual.join(",")}`);
}
for (const surface of manifest.surfaces) {
  if (!surface.copy_verified) throw new Error(`${surface.id}: copy not verified`);
  if (surface.direct_opencode_access !== false) throw new Error(`${surface.id}: direct OpenCode access is not prohibited`);
  if (!surface.integration?.commit) throw new Error(`${surface.id}: missing integration commit`);
  if (surface.integration.production_audit_vulnerabilities !== 0) throw new Error(`${surface.id}: production audit is not zero`);
  const experience = surface.integration.experience;
  if (!experience || experience.surface_id !== surface.id) throw new Error(`${surface.id}: missing Experience conformance`);
  if (!experience.watch || !experience.automated_proof) throw new Error(`${surface.id}: Experience watch/proof incomplete`);
  if (experience.optimistic_conflicts !== "preserve-409-no-blind-retry") throw new Error(`${surface.id}: unsafe conflict policy`);
  process.stdout.write(`${surface.id}\t${surface.intake_copy}\t${surface.integration.commit}\n`);
}
const tui = manifest.surfaces.find(surface => surface.id === "tui");
const artifact = tui?.integration?.runtime_artifact;
if (!artifact) throw new Error("tui: missing admitted runtime artifact");
const bytes = await readFile(artifact.path);
const digest = createHash("sha256").update(bytes).digest("hex");
if (digest !== artifact.sha256) throw new Error(`tui: runtime artifact hash mismatch ${digest}`);
const provenance = await readFile(artifact.provenance, "utf8");
if (!provenance.includes(`source_commit=${tui.integration.commit}`) || !provenance.includes(`sha256=${digest}`)) {
  throw new Error("tui: runtime artifact provenance mismatch");
}
process.stdout.write(`tui-runtime\t${artifact.path}\t${digest}\n`);
NODE

node --input-type=module <<'NODE'
import { readFile } from "node:fs/promises";

const token = (await readFile("/Volumes/Storage/FLOYD_RUNTIME/core/gateway.token", "utf8")).trim();
const response = await fetch("http://127.0.0.1:41414/api/health", {
  headers: { authorization: `Bearer ${token}` },
});
const health = await response.json();
if (!response.ok || health.ok !== true || health.engine?.ok !== true) {
  throw new Error(`Floyd Core health failed: HTTP ${response.status} ${JSON.stringify(health)}`);
}
process.stdout.write(`core\t${health.pid}\topencode\t${health.engine.pid}\n`);

const discoveryResponse = await fetch("http://127.0.0.1:41414/api/surfaces", {
  headers: { authorization: `Bearer ${token}` },
});
const discovery = await discoveryResponse.json();
const expectedIds = ["desktop", "ide", "pty", "launcher"];
if (!discoveryResponse.ok || !Array.isArray(discovery.surfaces)
  || JSON.stringify(discovery.surfaces.map(surface => surface.id)) !== JSON.stringify(expectedIds)
  || discovery.surfaces.some(surface => surface.verified !== true)) {
  throw new Error(`admitted surface discovery failed: HTTP ${discoveryResponse.status} ${JSON.stringify(discovery)}`);
}
for (const surface of discovery.surfaces) {
  process.stdout.write(`surface-discovery\t${surface.id}\t${surface.reason}\n`);
}
NODE

tab=$(printf '\t')
node --input-type=module - "$MANIFEST" <<'NODE' | while IFS="$tab" read -r id copy port; do
import { readFile } from "node:fs/promises";
const manifest = JSON.parse(await readFile(process.argv[2], "utf8"));
for (const surface of manifest.surfaces.filter(surface => surface.integration?.admitted_runtime_url)) {
  const port = new URL(surface.integration.admitted_runtime_url).port;
  process.stdout.write(`${surface.id}\t${surface.intake_copy}\t${port}\n`);
}
NODE
  pid=$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | sed -n '1p')
  [ -n "$pid" ] || {
    printf '%s has no admitted listener on %s\n' "$id" "$port" >&2
    exit 1
  }
  cwd=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')
  [ "$cwd" = "$copy" ] || {
    printf '%s listener %s has wrong cwd: %s\n' "$id" "$pid" "$cwd" >&2
    exit 1
  }
  launchctl print "gui/$(id -u)/com.floyd.surface.$id" >/dev/null
  printf 'surface-runtime\t%s\t%s\t%s\n' "$id" "$pid" "$cwd"
done

node --input-type=module - "$MANIFEST" <<'NODE' | while IFS="$tab" read -r id copy expected_head; do
import { readFile } from "node:fs/promises";
const manifest = JSON.parse(await readFile(process.argv[2], "utf8"));
for (const surface of manifest.surfaces) {
  process.stdout.write(`${surface.id}\t${surface.intake_copy}\t${surface.integration.commit}\n`);
}
NODE
  actual_head=$(git -C "$copy" rev-parse HEAD)
  [ "$actual_head" = "$expected_head" ] || {
    printf '%s head mismatch: expected %s, got %s\n' "$id" "$expected_head" "$actual_head" >&2
    exit 1
  }
  [ -z "$(git -C "$copy" status --porcelain)" ] || {
    printf '%s intake copy is dirty\n' "$id" >&2
    exit 1
  }
  printf '%s\t%s\tclean\n' "$id" "$(printf '%s' "$actual_head" | cut -c1-12)"
done

printf 'ACTIVE_SURFACES PASS\n'
