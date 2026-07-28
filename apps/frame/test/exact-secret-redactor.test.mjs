import test from "node:test";
import assert from "node:assert/strict";
import {
  createExactSecretRedactor,
  redactSecretText,
} from "../server/exact-secret-redactor.mjs";

test("exact secret redaction covers response headers and split streaming chunks", () => {
  const secret = "real-provider-secret-123";
  assert.equal(
    redactSecretText(`Bearer ${secret}`, [secret]),
    "Bearer [FLOYD_VAULT_REDACTED]",
  );
  const redactor = createExactSecretRedactor([secret]);
  const output = Buffer.concat([
    redactor.push(Buffer.from(`data: ${secret.slice(0, 8)}`)),
    redactor.push(Buffer.from(`${secret.slice(8)}\n\n`)),
    redactor.flush(),
  ]).toString("utf8");
  assert.doesNotMatch(output, /real-provider-secret/);
  assert.equal(output, "data: [FLOYD_VAULT_REDACTED]\n\n");
});
