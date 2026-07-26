import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderQrSvg } from "../src/qr.ts";

test("local QR renderer returns SVG geometry without echoing the bearer link", async () => {
  const link = "https://floyd.test/#handoff=hnd_1234567890abcdef.abcdefghijklmnopqrstuvwxyzABCDEFG123456789";
  const svg = await renderQrSvg(link);
  assert.match(svg, /<svg/);
  assert.match(svg, /<path|<rect/);
  assert.equal(svg.includes(link), false);
  assert.equal(Buffer.byteLength(svg) < 1024 * 1024, true);
});

test("local QR renderer bounds input before invoking the binary", async () => {
  await assert.rejects(renderQrSvg("x".repeat(4097)), (error: unknown) => {
    assert.equal((error as { statusCode?: number }).statusCode, 400);
    return true;
  });
});

test("local QR renderer rejects active markup from a substituted binary", async () => {
  const root = mkdtempSync(join(tmpdir(), "floyd-fake-qr-"));
  const binary = join(root, "qrencode");
  writeFileSync(binary, '#!/bin/sh\nprintf \'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>\'\n');
  chmodSync(binary, 0o700);
  try {
    await assert.rejects(renderQrSvg("https://floyd.test/#handoff=fake", binary), (error: unknown) => {
      assert.equal((error as { statusCode?: number }).statusCode, 503);
      assert.match(String(error), /inert geometry allowlist/);
      return true;
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
