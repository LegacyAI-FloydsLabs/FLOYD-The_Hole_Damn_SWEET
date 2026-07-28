/**
 * Associates live transport resources with the exact hashed-token record that
 * authenticated them. Revoking that record can therefore terminate in-flight
 * HTTP streams, WebSockets, upstream requests, and fetches immediately.
 */
export class VaultConnectionRegistry {
  #byToken = new Map();

  track(tokenId, resource) {
    if (!tokenId || !resource) throw new Error("token id and resource are required");
    const entry = {
      resource,
      release: () => this.#release(tokenId, entry),
    };
    const entries = this.#byToken.get(tokenId) || new Set();
    entries.add(entry);
    this.#byToken.set(tokenId, entries);
    for (const event of ["close", "finish", "end", "abort"]) {
      if (typeof resource.once === "function") resource.once(event, entry.release);
    }
    return entry.release;
  }

  terminate(tokenIds, reason = new Error("Vault capability revoked")) {
    let terminated = 0;
    for (const tokenId of new Set(tokenIds || [])) {
      const entries = [...(this.#byToken.get(tokenId) || [])];
      this.#byToken.delete(tokenId);
      for (const entry of entries) {
        const resource = entry.resource;
        try {
          if (typeof resource.abort === "function") resource.abort();
          else if (typeof resource.destroy === "function") resource.destroy();
          else if (typeof resource.close === "function") resource.close();
          else if (typeof resource.end === "function") resource.end();
          terminated += 1;
        } catch {
          // Revocation is best effort per resource, but continues across every
          // resource bound to the same token instead of stopping at one error.
        }
      }
    }
    return terminated;
  }

  count(tokenId) {
    return this.#byToken.get(tokenId)?.size || 0;
  }

  tokenIds() {
    return [...this.#byToken.keys()];
  }

  #release(tokenId, entry) {
    const entries = this.#byToken.get(tokenId);
    if (!entries) return;
    entries.delete(entry);
    if (!entries.size) this.#byToken.delete(tokenId);
  }
}
