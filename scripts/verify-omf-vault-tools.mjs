#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const token = `fv_omf_${"c".repeat(32)}`;
const failClosedOnly = process.argv.includes("--fail-closed-only");
const binaryArgument = process.argv.slice(2).find((argument) => !argument.startsWith("--"));
const binary = resolve(binaryArgument || "intake/surfaces/omf/bin/omp");
const agentDir = mkdtempSync(`${tmpdir()}/floyd-omf-tools-`);
const observed = [];
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString("utf8");
  observed.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body });

  if (req.url === "/p/tavily/search") {
    return json(res, 200, {
      answer: "vault-tavily-proof",
      results: [{
        title: "Vault result",
        url: "https://example.test/result",
        content: "vault-tavily-proof",
      }],
      request_id: "vault-search-request",
    });
  }
  if (req.url?.startsWith("/p/github/repos/openai/codex/issues/1/comments")) {
    return json(res, 200, []);
  }
  if (req.url === "/p/github/repos/openai/codex/issues/1") {
    return json(res, 200, {
      number: 1,
      title: "vault-github-proof",
      body: "GitHub data arrived through Floyd Vault.",
      state: "open",
      state_reason: null,
      user: { login: "vault-fixture" },
      labels: [],
      comments: 0,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      html_url: "https://github.com/openai/codex/issues/1",
    });
  }
  return json(res, 404, { error: `unexpected proof route ${req.url}` });
});

await new Promise((resolvePromise, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolvePromise);
});
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
const env = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  TMPDIR: process.env.TMPDIR,
  PI_CODING_AGENT_DIR: agentDir,
  FLOYD_VAULT_PROXY_URL: base,
  FLOYD_VAULT_PROXY_TOKEN: token,
  FLOYD_VAULT_TAVILY_BASE_URL: `${base}/p/tavily`,
  FLOYD_VAULT_GITHUB_BASE_URL: `${base}/p/github`,
  TAVILY_API_KEY: token,
  GITHUB_TOKEN: token,
  GH_TOKEN: token,
  NO_COLOR: "1",
};

try {
  const tavilyFailClosedEnv = { ...env };
  delete tavilyFailClosedEnv.FLOYD_VAULT_TAVILY_BASE_URL;
  const tavilyFailClosed = await run(
    binary,
    ["search", "--provider", "tavily", "--limit", "1", "vault routing proof"],
    tavilyFailClosedEnv,
  );
  if (
    tavilyFailClosed.code === 0
    || !`${tavilyFailClosed.stdout}\n${tavilyFailClosed.stderr}`.includes("Floyd Vault Tavily route is required")
  ) {
    throw new Error(`OMF Tavily did not fail closed: ${tavilyFailClosed.stderr || tavilyFailClosed.stdout}`);
  }

  const githubFailClosedEnv = { ...env };
  delete githubFailClosedEnv.FLOYD_VAULT_GITHUB_BASE_URL;
  const githubFailClosed = await run(
    binary,
    ["read", "https://github.com/openai/codex/issues/1"],
    githubFailClosedEnv,
  );
  if (
    githubFailClosed.code === 0
    || !`${githubFailClosed.stdout}\n${githubFailClosed.stderr}`.includes("Floyd Vault GitHub route is required")
  ) {
    throw new Error(`OMF GitHub did not fail closed: ${githubFailClosed.stderr || githubFailClosed.stdout}`);
  }
  if (observed.some((entry) => entry.url.startsWith("/p/"))) {
    throw new Error("A fail-closed invocation reached a provider route");
  }

  if (failClosedOnly) {
    console.log("OMF_VAULT_MARKERS PASS fail_closed=tavily+github");
  } else {
    const tavily = await run(binary, ["search", "--provider", "tavily", "--limit", "1", "vault routing proof"], env);
    if (tavily.code !== 0 || !`${tavily.stdout}\n${tavily.stderr}`.includes("vault-tavily-proof")) {
      throw new Error(`OMF Tavily proof failed (${tavily.code}): ${tavily.stderr || tavily.stdout}`);
    }
    const github = await run(binary, ["read", "https://github.com/openai/codex/issues/1"], env);
    if (github.code !== 0 || !`${github.stdout}\n${github.stderr}`.includes("vault-github-proof")) {
      throw new Error(`OMF GitHub proof failed (${github.code}): ${github.stderr || github.stdout}`);
    }

    const toolRequests = observed.filter((entry) => entry.url.startsWith("/p/"));
    if (!toolRequests.some((entry) => entry.url === "/p/tavily/search")) throw new Error("Tavily did not reach Vault");
    if (!toolRequests.some((entry) => entry.url === "/p/github/repos/openai/codex/issues/1")) {
      throw new Error("GitHub did not reach Vault");
    }
    if (toolRequests.some((entry) => entry.authorization !== `Bearer ${token}`)) {
      throw new Error("OMF tool request did not use the fv_ capability");
    }
    const serialized = JSON.stringify(observed);
    if (/api\.tavily\.com|api\.github\.com|real-provider/i.test(serialized)) {
      throw new Error("OMF proof observed a vendor destination or real credential");
    }
    console.log(
      `OMF_VAULT_TOOLS PASS tavily=loopback+fv github=loopback+fv`
      + ` fail_closed=tavily+github requests=${toolRequests.length}`,
    );
  }
} finally {
  server.closeAllConnections?.();
  await new Promise((resolvePromise) => server.close(resolvePromise));
}

function run(command, args, environment) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(
        `compiled OMF tool timed out: ${args.join(" ")}\n`
        + `stdout=${Buffer.concat(stdout).toString("utf8")}\n`
        + `stderr=${Buffer.concat(stderr).toString("utf8")}\n`
        + `observed=${JSON.stringify(observed)}`,
      ));
    }, 20_000);
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolvePromise({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

function json(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}
