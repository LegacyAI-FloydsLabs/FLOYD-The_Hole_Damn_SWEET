const REPLACEMENT = Buffer.from("[FLOYD_VAULT_REDACTED]");

export function redactSecretText(value, secrets) {
  let result = String(value);
  for (const secret of normalizeSecrets(secrets)) {
    result = result.split(secret.toString()).join(REPLACEMENT.toString());
  }
  return result;
}

export function createExactSecretRedactor(secrets) {
  const needles = normalizeSecrets(secrets);
  let pending = Buffer.alloc(0);
  return {
    push(chunk) {
      pending = redact(Buffer.concat([pending, Buffer.from(chunk)]), needles);
      const retained = longestPossibleSecretPrefix(pending, needles);
      const output = pending.subarray(0, pending.length - retained);
      pending = pending.subarray(pending.length - retained);
      return output;
    },
    flush() {
      const output = redact(pending, needles);
      pending = Buffer.alloc(0);
      return output;
    },
  };
}

export async function pipeRedactedBody(body, destination, secrets) {
  if (!body) return;
  const redactor = createExactSecretRedactor(secrets);
  for await (const chunk of body) {
    const output = redactor.push(chunk);
    if (output.length) destination.write(output);
  }
  const final = redactor.flush();
  if (final.length) destination.write(final);
}

function normalizeSecrets(secrets) {
  return [...new Set((secrets || [])
    .filter((value) => typeof value === "string" && value)
    .map(String))]
    .map((value) => Buffer.from(value));
}

function redact(input, needles) {
  if (!needles.length || !input.length) return input;
  const parts = [];
  let offset = 0;
  while (offset < input.length) {
    let matchIndex = -1;
    let matchNeedle = null;
    for (const needle of needles) {
      const index = input.indexOf(needle, offset);
      if (index >= 0 && (matchIndex < 0 || index < matchIndex)) {
        matchIndex = index;
        matchNeedle = needle;
      }
    }
    if (matchIndex < 0) {
      parts.push(input.subarray(offset));
      break;
    }
    parts.push(input.subarray(offset, matchIndex), REPLACEMENT);
    offset = matchIndex + matchNeedle.length;
  }
  return Buffer.concat(parts);
}

function longestPossibleSecretPrefix(input, needles) {
  const maximum = Math.min(
    input.length,
    Math.max(0, ...needles.map((needle) => needle.length - 1)),
  );
  for (let length = maximum; length > 0; length -= 1) {
    const suffix = input.subarray(input.length - length);
    if (needles.some((needle) => needle.subarray(0, length).equals(suffix))) return length;
  }
  return 0;
}
