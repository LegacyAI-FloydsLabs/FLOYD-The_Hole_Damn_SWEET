import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface Surface {
  id: string;
  remote: string | null;
  local_source: string | null;
  direct_opencode_access: boolean;
  intake_copy: string;
  copy_verified: boolean;
  integration: {
    commit: string;
    experience: {
      status: "verified" | "verified_transport";
      surface_id: string;
      restore: string[];
      publish: string[];
      watch: boolean;
      semantic_transcript_owner?: boolean;
      optimistic_conflicts: string;
      automated_proof: boolean;
    };
    runtime_artifact?: { path: string; sha256: string; architecture: string; provenance: string };
  };
}

test("ecosystem manifest names every active surface behind Floyd Core", () => {
  const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "../../../ecosystem/surfaces.json"), "utf8")) as {
    authority: { core: string; coding_engine: string; surface_contract: string };
    surfaces: Surface[];
  };
  const expected = ["desktop", "ide", "tui", "pty", "launcher"];
  assert.deepEqual(manifest.surfaces.map((surface) => surface.id).sort(), expected.sort());
  assert.equal(manifest.authority.core, "Floyd Core");
  assert.match(manifest.authority.coding_engine, /OpenCode 1\.17\.18/);
  assert.equal(manifest.authority.surface_contract, "@floyd/sdk");
  for (const surface of manifest.surfaces) {
    assert.equal(surface.direct_opencode_access, false, `${surface.id} must not bypass Core`);
    assert.ok(surface.remote || surface.local_source, `${surface.id} needs verified provenance`);
    assert.equal(surface.copy_verified, true, `${surface.id} needs an independently verified copy`);
    assert.match(surface.intake_copy, new RegExp(`/intake/surfaces/${surface.id}$`));
    assert.equal(surface.integration.experience.surface_id, surface.id);
    assert.equal(surface.integration.experience.watch, true, `${surface.id} must watch the Core envelope`);
    assert.equal(surface.integration.experience.automated_proof, true, `${surface.id} lacks conformance proof`);
    assert.equal(surface.integration.experience.optimistic_conflicts, "preserve-409-no-blind-retry");
    assert.ok(surface.integration.experience.restore.length > 0, `${surface.id} restores no portable state`);
    assert.ok(surface.integration.experience.publish.length > 0, `${surface.id} publishes no surface state`);
  }
  for (const transport of manifest.surfaces.filter((surface) => ["pty", "launcher"].includes(surface.id))) {
    assert.equal(transport.integration.experience.status, "verified_transport");
    assert.equal(transport.integration.experience.semantic_transcript_owner, false);
    assert.deepEqual(transport.integration.experience.publish.filter((field) => field === "composer-draft"), []);
  }
  const tui = manifest.surfaces.find((surface) => surface.id === "tui");
  assert.ok(tui?.integration.runtime_artifact);
  assert.match(tui.integration.runtime_artifact.sha256, /^[0-9a-f]{64}$/);
});
