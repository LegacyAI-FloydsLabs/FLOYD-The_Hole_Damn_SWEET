export function prepareOmpInvocation(raw, capability, managementUrl = "http://127.0.0.1:13030/#vault") {
  const command = raw[0];
  const action = raw[1];
  if (
    command === "auth-broker"
    && ["login", "logout", "import", "migrate", "serve"].includes(action)
  ) {
    return { kind: "vault-handoff", managementUrl };
  }
  if (raw.some((value) => value === "--api-key" || value.startsWith("--api-key="))) {
    return { kind: "vault-handoff", managementUrl };
  }
  return { kind: "launch", args: normalizeOmpArgs(raw, capability) };
}

export function normalizeOmpArgs(raw, capability) {
  const args = [];
  for (let index = 0; index < raw.length; index += 1) {
    const value = raw[index];
    if (value === "--api-key") {
      if (index + 1 < raw.length) index += 1;
      args.push("--api-key", capability);
      continue;
    }
    if (value.startsWith("--api-key=")) {
      args.push(`--api-key=${capability}`);
      continue;
    }
    args.push(value);
  }
  return args;
}
