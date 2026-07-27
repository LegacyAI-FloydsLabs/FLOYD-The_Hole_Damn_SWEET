---
name: tool-contract-validation
description: Validate MCP tool/resource contracts — schema quality, descriptions, error semantics — and prove each tool with a live valid+invalid call. Use when auditing or shipping an MCP server.
---

# Tool Contract Validation

A registered tool is not a working tool. Validate the contract, then exercise
it.

Contract audit (per tool from `tools/list`):
- Name: stable, namespaced, matches what the client references.
- inputSchema: present and parses as JSON Schema; required fields typed; no
  bare `{"type":"object"}` with no properties; enums where the domain is
  closed. Missing/empty descriptions are defects — the model calling this tool
  reads them.
- Output shape: documented and consistent; errors returned as JSON-RPC errors
  with useful messages, not thrown or swallowed.

Live exercise (per tool under test):
- Happy path: one real call with valid arguments → assert the result is
  well-formed and semantically correct, not merely non-error.
- Error path: one call with missing/invalid arguments → assert a clean
  JSON-RPC error and no stream corruption or hang.
- Idempotency/side-effects: for mutating tools, note what state changed and
  whether re-calling is safe.

Receipt: table of tool → schema OK? → valid-call result → invalid-call
behavior. Any tool without both call results is reported as UNVERIFIED, never
as working.
