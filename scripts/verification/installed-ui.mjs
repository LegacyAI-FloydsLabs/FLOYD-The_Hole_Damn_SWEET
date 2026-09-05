import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_OS !== 'macOS') {
  throw new Error('This test changes the disposable cloud Mac browser settings; run it only in GitHub Actions.');
}
const mode = process.argv[2];
const endpoint = 'http://127.0.0.1:19222';
const output = join(process.env.GITHUB_WORKSPACE, 'dist', 'installed-ui-evidence');
await mkdir(output, { recursive: true });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { const result = await check(); if (result) return result; } catch (error) { last = error; }
    await pause(200);
  }
  throw new Error(`${message}${last ? `: ${last.message}` : ''}`);
}

if (mode === 'prepare') {
  // Configure a normal GUI browser on this disposable account. FLOYD's own
  // unchanged `open` command must subsequently deliver its URL to this browser.
  execFileSync('/usr/bin/xcrun', ['swift', '-e', 'import CoreServices; import Foundation; for scheme in ["http", "https"] { let result = LSSetDefaultHandlerForURLScheme(scheme as CFString, "com.google.Chrome" as CFString); if result != 0 { exit(1) } }'], { stdio: 'inherit' });
  execFileSync('/usr/bin/open', ['-na', 'Google Chrome', '--args',
    `--user-data-dir=${join(process.env.RUNNER_TEMP, 'floyd-default-browser')}`,
    '--remote-debugging-port=19222', '--remote-debugging-address=127.0.0.1',
    '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'inherit' });
  await until(async () => (await fetch(`${endpoint}/json/version`)).ok, 'Cloud default browser did not start');
  console.log('FLOYD_UI_BROWSER_READY');
} else if (mode === 'verify') {
  const browser = await chromium.connectOverCDP(endpoint);
  const failures = [];
  const terminalOutput = [];
  const receipt = { source_commit: process.env.GITHUB_SHA, automatically_opened: false, surfaces: [], failures };
  let page;
  try {
    page = await until(() => browser.contexts().flatMap(c => c.pages()).find(p => p.url() === 'http://127.0.0.1:13030/'), 'FLOYD did not open its interface in the default browser');
    receipt.automatically_opened = true;
    await page.setViewportSize({ width: 1440, height: 1000 });
    page.on('pageerror', error => failures.push({ kind: 'javascript', message: error.message }));
    page.on('websocket', socket => {
      if (socket.url().startsWith('ws://127.0.0.1:')) {
        socket.on('framereceived', event => terminalOutput.push(String(event.payload)));
      }
    });
    page.on('requestfailed', request => {
      if (request.url().startsWith('http://127.0.0.1:') && request.failure()?.errorText !== 'net::ERR_ABORTED') {
        failures.push({ kind: 'network', url: request.url().split('?')[0], error: request.failure()?.errorText });
      }
    });
    page.on('response', response => {
      if (response.url().startsWith('http://127.0.0.1:') && response.status() >= 400) {
        failures.push({ kind: 'http', url: response.url().split('?')[0], status: response.status() });
      }
    });
    // Observe a complete asset load in the very same page FLOYD opened.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#appList .app').first().waitFor();
    assert.equal(await page.title(), 'FLOYD');
    await page.screenshot({ path: join(output, '01-floyd-opened.png') });
    const registry = await page.evaluate(async () => (await (await fetch('/api/registry')).json()).apps);
    const expected = ['floyd-code-cli', 'cursem-ide', 'floyd-desktop', 'ohmyfloyd', 'browork', 'harness-launcher'];
    assert.deepEqual(registry.map(app => app.id).sort(), expected.sort());
    for (const app of registry) {
      await page.locator('#drawer').hover();
      await page.locator('#appList .app').filter({ hasText: app.name }).first().click();
      const iframe = page.locator('iframe.stage-frame.active');
      await until(async () => await iframe.getAttribute('title') === app.name, `${app.name} did not become active`);
      const frame = await (await iframe.elementHandle()).contentFrame();
      await frame.waitForLoadState('domcontentloaded');
      await frame.waitForFunction(() => document.body && (document.body.innerText.trim().length > 15 || document.querySelector('.xterm-screen, canvas')), null, { timeout: 20000 });
      await page.screenshot({ path: join(output, `${app.id}.png`) });
      receipt.surfaces.push({ id: app.id, url: frame.url(), rendered: true });
    }
    await page.locator('#drawer').hover();
    await page.locator('#appList .app').filter({ hasText: 'CURSEM-IDE' }).first().click();
    const ide = await (await page.locator('iframe.stage-frame.active').elementHandle()).contentFrame();
    const terminal = ide.locator('section[aria-label="TerminalOne"]');
    if (!await terminal.isVisible()) await ide.getByRole('button', { name: 'Toggle terminal', exact: true }).click();
    const input = terminal.locator('.xterm-helper-textarea').first();
    await input.waitFor({ state: 'attached' });
    await input.focus();
    await input.pressSequentially('printf \'FLOYD-CHECK-%s\\n\' "$((20+22))"');
    await input.press('Enter');
    await until(() => terminalOutput.join('').includes('FLOYD-CHECK-42'), 'Installed terminal did not execute the typed command');
    receipt.terminal_command_result = 'FLOYD-CHECK-42';
    await page.screenshot({ path: join(output, 'cursem-terminal-command.png') });
    // Returning to an already-open surface must preserve its browser instance.
    const desktopBefore = page.frames().find(frame => frame.url() === 'http://127.0.0.1:13010/');
    await page.locator('#drawer').hover();
    await page.locator('#appList .app').filter({ hasText: 'FLOYD DESKTOP' }).first().click();
    assert.ok(page.frames().includes(desktopBefore), 'Switching surfaces replaced the desktop session');
    await page.locator('#chipHome').click();
    await page.locator('#chipBg').click();
    await page.waitForFunction(() => document.querySelector('#stageBg').style.backgroundImage.includes('/backgrounds/'));
    const images = await page.evaluate(() => Array.from(document.images).filter(image => image.getClientRects().length && image.complete && !image.naturalWidth).map(image => image.src));
    assert.deepEqual(images, [], 'Visible FLOYD image failed to load');
    await page.screenshot({ path: join(output, '02-return-home.png') });
    assert.deepEqual(failures, [], 'Installed interface had JavaScript or local resource failures');
    receipt.result = 'pass';
    console.log(`FLOYD_INSTALLED_UI PASS automatically_opened=true rendered_surfaces=${receipt.surfaces.length} terminal_command=pass state_preserved=true`);
  } catch (error) {
    receipt.result = 'fail';
    receipt.error = error.message;
    if (page) await page.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
    throw error;
  } finally {
    await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
    // Disconnect without terminating the default browser or app under test.
    await browser.close();
  }
} else {
  throw new Error('Usage: installed-ui.mjs prepare|verify');
}
