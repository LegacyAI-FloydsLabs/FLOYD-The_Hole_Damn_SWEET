import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { VaultConnectionRegistry } from "../server/vault-connection-registry.mjs";

class Resource extends EventEmitter {
  constructor() {
    super();
    this.destroyedBy = null;
  }
  destroy(reason) {
    this.destroyedBy = reason || true;
    this.emit("close");
  }
}

test("revocation terminates every live resource for only the revoked token", () => {
  const registry = new VaultConnectionRegistry();
  const http = new Resource();
  const websocket = new Resource();
  const other = new Resource();
  registry.track("token-a", http);
  registry.track("token-a", websocket);
  registry.track("token-b", other);
  assert.equal(registry.terminate(["token-a"]), 2);
  assert.equal(http.destroyedBy, true);
  assert.equal(websocket.destroyedBy, true);
  assert.equal(other.destroyedBy, null);
  assert.equal(registry.count("token-a"), 0);
  assert.equal(registry.count("token-b"), 1);
});

test("completed resources release themselves before later revocation", () => {
  const registry = new VaultConnectionRegistry();
  const completed = new Resource();
  registry.track("token-a", completed);
  completed.emit("finish");
  assert.equal(registry.terminate(["token-a"]), 0);
  assert.equal(completed.destroyedBy, null);
});
