/**
 * Vault GLM-fallback visibility.
 *
 * When the Vault proxy serves a chat request with its GLM fallback (the
 * requested provider has no key or hard-failed), the response carries
 * `x-floyd-fallback: <original-provider-id>` and
 * `x-floyd-fallback-model: <actual-model>`. The failure must be visible to
 * the operator: these helpers read the marker headers and capture them from
 * SDK traffic so chat endpoints can annotate their responses.
 */

export type VaultFallbackNotice = Readonly<{
  /** Provider id that failed and was fallen back from. */
  provider: string;
  /** Actual model that answered (GLM), when the Vault reported it. */
  model: string | null;
}>;

/** Read the Vault fallback marker headers, or null when the response was served directly. */
export function readVaultFallback(headers: Headers): VaultFallbackNotice | null {
  const provider = headers.get('x-floyd-fallback');
  if (!provider || !provider.trim()) return null;
  const model = headers.get('x-floyd-fallback-model');
  return Object.freeze({
    provider: provider.trim(),
    model: model && model.trim() ? model.trim() : null,
  });
}

/**
 * Wrap global fetch for the OpenAI/Anthropic SDK clients so every upstream
 * response is checked for the fallback marker. Once any response in a
 * request's agentic loop fell back, `notice()` keeps reporting it — the
 * operator must see that GLM answered even if later turns recovered.
 */
export function captureVaultFallback(): {
  fetch: typeof globalThis.fetch;
  notice: () => VaultFallbackNotice | null;
} {
  let last: VaultFallbackNotice | null = null;
  const wrapped = (async (...args: Parameters<typeof globalThis.fetch>) => {
    const response = await globalThis.fetch(...args);
    last = readVaultFallback(response.headers) ?? last;
    return response;
  }) as typeof globalThis.fetch;
  return { fetch: wrapped, notice: () => last };
}
