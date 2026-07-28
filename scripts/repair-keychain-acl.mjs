#!/usr/bin/env node
// One-time repair: rewrite every existing Floyd Vault Keychain item so its
// ACL trusts /usr/bin/security, ending the per-read password prompts caused
// by the original empty-ACL (-T "") writes. Reading each item may prompt
// once; rewriting uses the new trusted ACL.
import {
  FLOYD_KEYCHAIN_ACCOUNTS,
  MacOSKeychainVault,
} from "../apps/frame/server/keychain-vault.mjs";

const vault = new MacOSKeychainVault();
for (const account of Object.values(FLOYD_KEYCHAIN_ACCOUNTS)) {
  let value;
  try {
    value = vault.get(account);
  } catch (error) {
    console.log(`${account}: unreadable (${error.message.split(":").pop().trim()})`);
    continue;
  }
  if (value === null) {
    console.log(`${account}: absent`);
    continue;
  }
  if (!value) {
    console.log(`${account}: EMPTY (single-line stdin bug) — deleting bad item`);
    vault.delete(account);
    continue;
  }
  vault.delete(account);
  vault.set(account, value);
  console.log(`${account}: rewritten with trusted ACL (${value.length} chars)`);
}
