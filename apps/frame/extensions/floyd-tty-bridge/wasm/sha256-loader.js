const FALLBACK_WASM_CANARY_BYTES = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f,
  0x03, 0x02, 0x01, 0x00,
  0x07, 0x07, 0x01, 0x03, 0x61, 0x64, 0x64, 0x00, 0x00,
  0x0a, 0x09, 0x01, 0x07, 0x00, 0x20, 0x00, 0x20, 0x01, 0x6a, 0x0b
]);

let wasmCanaryPromise;

async function loadCanaryBytes() {
  if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.getURL === 'function' && typeof fetch === 'function') {
    try {
      const response = await fetch(chrome.runtime.getURL('wasm/sha256.wasm'));
      if (response && response.ok) {
        const wasmBuffer = await response.arrayBuffer();
        return new Uint8Array(wasmBuffer);
      }
    } catch (error) {
      void error;
    }
  }

  return FALLBACK_WASM_CANARY_BYTES;
}

export async function ensureWasmCanary() {
  if (!wasmCanaryPromise) {
    wasmCanaryPromise = (async () => {
      const wasmBytes = await loadCanaryBytes();
      const { instance } = await WebAssembly.instantiate(wasmBytes);
      if (!instance || typeof instance.exports.add !== 'function') {
        throw new Error('WASM canary did not expose add(a, b)');
      }

      const canaryValue = instance.exports.add(20, 22);
      if (canaryValue !== 42) {
        throw new Error('WASM canary returned unexpected value');
      }

      return { ok: true, canaryValue };
    })();
  }

  return wasmCanaryPromise;
}

async function getSubtle() {
  if (globalThis.crypto && globalThis.crypto.subtle) {
    return globalThis.crypto.subtle;
  }

  if (typeof process !== 'undefined' && process.versions && process.versions.node) {
    const nodeCrypto = await import('node:crypto');
    return nodeCrypto.webcrypto.subtle;
  }

  throw new Error('No SubtleCrypto implementation available');
}

export async function computeSHA256(input) {
  await ensureWasmCanary();

  const subtle = await getSubtle();
  const normalized = String(input ?? '');
  const encoded = new TextEncoder().encode(normalized);
  const digestBuffer = await subtle.digest('SHA-256', encoded);

  return Array.from(new Uint8Array(digestBuffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
