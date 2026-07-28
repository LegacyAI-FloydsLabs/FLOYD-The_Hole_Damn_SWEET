#!/usr/bin/env node
import { existsSync } from "node:fs";
import {
  inspectOmfCredentialStore,
  lockOmfCredentialStore,
} from "./lib/omf-credential-store.mjs";

const args = process.argv.slice(2);
const requireEmpty = args.includes("--require-empty");
const [databasePath] = args.filter((value) => value !== "--require-empty");
if (!databasePath || !existsSync(databasePath)) {
  console.error("usage: lock-omf-credential-store.mjs [--require-empty] <initialized-agent.db>");
  process.exit(64);
}

if (requireEmpty && inspectOmfCredentialStore(databasePath).rows.length) {
  console.error("OMF direct credentials require the recoverable Vault migration before launch");
  process.exit(78);
}
const result = lockOmfCredentialStore(databasePath);
console.log(JSON.stringify(result));
