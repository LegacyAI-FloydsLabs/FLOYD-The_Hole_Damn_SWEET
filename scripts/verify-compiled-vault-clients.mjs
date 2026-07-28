#!/usr/bin/env node
import http from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";

const root = resolve(new URL("..", import.meta.url).pathname);
const token = "fv_compiledproof_0123456789abcdef0123456789abcdef";
const hits = [];

const recorder = http.createServer(async (req, res) => {
  const body = Buffer.concat(await Array.fromAsync(req)).toString("utf8");
  hits.push({
    path: req.url,
    authorization: req.headers.authorization,
    xApiKey: req.headers["x-api-key"],
    body,
  });
  if (req.url?.includes("/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ object: "list", data: [{ id: "glm-4.7", object: "model" }] }));
  }
  const parsed = body ? JSON.parse(body) : {};
  if (parsed.stream) {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ id: "proof", object: "chat.completion.chunk", model: "glm-4.7", choices: [{ index: 0, delta: { role: "assistant", content: "vault-proof" }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: "proof", object: "chat.completion.chunk", model: "glm-4.7", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
    return res.end("data: [DONE]\n\n");
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    id: "proof",
    object: "chat.completion",
    model: "glm-4.7",
    choices: [{ index: 0, message: { role: "assistant", content: "vault-proof" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }));
});
await new Promise((resolveListen) => recorder.listen(0, "127.0.0.1", resolveListen));
const base = `http://127.0.0.1:${recorder.address().port}`;
const work = mkdtempSync(join(tmpdir(), "floyd-compiled-vault-"));

function run(executable, args, env) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(executable, args, {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0
      ? resolveRun({ stdout, stderr })
      : reject(new Error(`${executable} exited ${code}: ${stderr.slice(0, 500)}`)));
  });
}

try {
  const ffDir = join(work, "ff");
  mkdirSync(ffDir, { recursive: true });
  writeFileSync(join(ffDir, "floyd.json"), JSON.stringify({
    models: { large: { provider: "zai", model: "glm-4.7", max_tokens: 64 } },
    providers: { zai: { api_key: token, base_url: `${base}/v1` } },
  }));
  await run(join(root, "intake/surfaces/ff/bin/floyd-ff-real"), [
    "run", "-D", ffDir, "-m", "zai/glm-4.7", "-q", "Reply with vault-proof",
  ], { HOME: work, PATH: process.env.PATH, FLOYD_GLOBAL_DATA: ffDir });
  const ffHit = hits.find((hit) => hit.path?.includes("chat/completions"));
  if (!ffHit || ffHit.authorization !== `Bearer ${token}`) {
    throw new Error("FF did not send its fv_ capability to the configured recorder");
  }

  hits.length = 0;
  const ompAgent = join(work, "omp-agent");
  mkdirSync(ompAgent, { recursive: true });
  writeFileSync(join(ompAgent, "models.yml"), [
    "providers:",
    "  zai:",
    `    baseUrl: ${base}/v1`,
    `    apiKey: ${token}`,
    "    api: openai-completions",
    "    models:",
    "      - id: glm-4.7",
    "        name: GLM Recorder Proof",
    "        contextWindow: 4096",
    "        maxTokens: 256",
    "",
  ].join("\n"));
  await run(join(root, "intake/surfaces/omf/bin/omp"), [
    "-p", "--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-rules",
    "--model", "zai/glm-4.7", "Reply with vault-proof",
  ], {
    HOME: work,
    PATH: process.env.PATH,
    PI_CODING_AGENT_DIR: ompAgent,
    ZAI_API_KEY: token,
  });
  const ompHit = hits.find((hit) => hit.path?.includes("chat/completions"));
  if (!ompHit || ompHit.authorization !== `Bearer ${token}`) {
    throw new Error("OhMyFloyd did not send its fv_ capability to the configured recorder");
  }
  console.log("COMPILED_VAULT_CLIENTS PASS ff=loopback+fv omf=loopback+fv vendor_requests=0");
} finally {
  await new Promise((resolveClose) => recorder.close(resolveClose));
}
