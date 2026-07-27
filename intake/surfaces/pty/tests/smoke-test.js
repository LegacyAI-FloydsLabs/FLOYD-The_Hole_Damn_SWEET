#!/usr/bin/env node
/**
 * Smoke + functional test for TerminalOne.
 * - Spawns the server on TEST_PORT (default 11001).
 * - HTTP: verifies /health and that index.html ships the settings UI.
 * - Browser (puppeteer): verifies the style toggle, the 12 color themes
 *   (incl. Matrix + all VOID themes), that a theme persists across a style
 *   change, the Matrix digital-rain canvas activates, and that style/theme
 *   persist across reload (localStorage).
 */

const http = require('http');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const PORT = process.env.TEST_PORT || 11001;
const HOST = 'localhost';
const BASE_URL = `http://${HOST}:${PORT}`;

const EXPECTED_THEMES = [
  'tokyo-night', 'absolute-void', 'matrix', 'dracula', 'gruvbox', 'nord',
  'catppuccin', 'solarized-dark', 'solarized-light', 'monokai', 'one-dark', 'github-dark'
];
// Themes copied from /Volumes/Storage/DEEPCODE_WORKFLOW/VOID
const VOID_THEMES = ['absolute-void', 'dracula', 'tokyo-night', 'gruvbox', 'nord', 'matrix', 'catppuccin'];

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT FAILED: ' + msg);
  console.log('  ✓ ' + msg);
}

function get(p) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${BASE_URL}${p}`, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error(`timeout on ${p}`)); });
  });
}

async function waitForHealth(timeoutMs = 20000) {
  const start = Date.now();
  for (;;) {
    try {
      const r = await get('/health');
      if (r.statusCode === 200) return r;
    } catch (_) { /* not up yet */ }
    if (Date.now() - start > timeoutMs) throw new Error('server did not become healthy in time');
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function assertTestPortFree() {
  await new Promise((resolve, reject) => {
    const socket = net.connect({ host: HOST, port: PORT });
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error(`could not prove TEST_PORT ${PORT} is free`));
    }, 1000);
    socket.once('connect', () => {
      clearTimeout(timeout);
      socket.destroy();
      reject(new Error(`TEST_PORT ${PORT} is already occupied; refusing to test another process`));
    });
    socket.once('error', (error) => {
      clearTimeout(timeout);
      socket.destroy();
      if (error.code === 'ECONNREFUSED') resolve();
      else reject(error);
    });
  });
}

async function run() {
  console.log('TerminalOne smoke + functional tests');
  console.log(`Target: ${BASE_URL}\n`);

  await assertTestPortFree();
  const server = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), TERMINALONE_ALLOWED_ORIGIN: BASE_URL },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });

  let browser = null;
  try {
    await waitForHealth();
    if (server.exitCode !== null) throw new Error(`copy server exited during startup with ${server.exitCode}`);

    // ── HTTP layer ──
    console.log('HTTP:');
    const health = await get('/health');
    const healthJson = JSON.parse(health.body);
    assert(healthJson.status === 'ok', 'GET /health returns {status:"ok"}');

    const page = await get('/');
    assert(page.statusCode === 200, 'GET / returns 200');
    for (const id of ['fxCanvas', 'settingsBtn', 'styleSelect', 'themeSelect']) {
      assert(page.body.includes(`id="${id}"`), `index.html contains #${id}`);
    }
    assert(page.body.includes('Floyd TTY Bridge'), 'index.html offers the Floyd TTY Bridge style');

    // ── Browser layer ──
    console.log('\nBrowser:');
    const puppeteer = require('puppeteer');
    browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const pg = await browser.newPage();
    await pg.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await pg.waitForFunction('window.__terminalOne && window.__terminalOne.themes().length > 0', { timeout: 10000 });

    const themes = await pg.evaluate(() => window.__terminalOne.themes());
    assert(themes.length === 12, `12 color themes available (got ${themes.length})`);
    for (const id of EXPECTED_THEMES) assert(themes.includes(id), `theme present: ${id}`);
    for (const id of VOID_THEMES) assert(themes.includes(id), `VOID theme copied over: ${id}`);

    const def = await pg.evaluate(() => ({
      theme: window.__terminalOne.theme, style: window.__terminalOne.style,
      bodyTheme: document.body.dataset.theme, bodyStyle: document.body.dataset.style
    }));
    assert(def.theme === 'tokyo-night' && def.bodyTheme === 'tokyo-night', 'default theme = tokyo-night');
    assert(def.style === 'default' && def.bodyStyle === 'default', 'default style = default');

    // Matrix theme: digital-rain canvas activates + translucent terminal bg
    const mtx = await pg.evaluate(() => {
      window.__terminalOne.setTheme('matrix');
      return {
        bodyTheme: document.body.dataset.theme,
        canvasDisplay: getComputedStyle(document.getElementById('fxCanvas')).display,
        termBg: window.__terminalOne.termTheme().background
      };
    });
    assert(mtx.bodyTheme === 'matrix', 'selecting Matrix sets data-theme="matrix"');
    assert(mtx.canvasDisplay === 'block', 'Matrix activates the digital-rain canvas');
    assert(/rgba|hsla/.test(mtx.termBg), 'Matrix uses a translucent terminal bg so rain shows through');

    // Theme persists across a style change (Floyd) — the core requirement
    const afterStyle = await pg.evaluate(() => {
      window.__terminalOne.setStyle('floyd');
      return {
        style: window.__terminalOne.style, theme: window.__terminalOne.theme,
        bodyStyle: document.body.dataset.style, bodyTheme: document.body.dataset.theme
      };
    });
    assert(afterStyle.style === 'floyd' && afterStyle.bodyStyle === 'floyd', 'switching to Floyd style applies');
    assert(afterStyle.theme === 'matrix' && afterStyle.bodyTheme === 'matrix', 'theme persists across style change (matrix stays under Floyd)');

    // Switch style back to default — theme still matrix
    const backDefault = await pg.evaluate(() => {
      window.__terminalOne.setStyle('default');
      return { style: window.__terminalOne.style, theme: window.__terminalOne.theme };
    });
    assert(backDefault.style === 'default' && backDefault.theme === 'matrix', 'theme persists switching Floyd → default too');

    // Persistence across reload (localStorage): set a distinct combo, reload, verify
    await pg.evaluate(() => { window.__terminalOne.setTheme('gruvbox'); window.__terminalOne.setStyle('floyd'); });
    await pg.reload({ waitUntil: 'domcontentloaded' });
    await pg.waitForFunction('window.__terminalOne && window.__terminalOne.themes().length > 0', { timeout: 10000 });
    const persisted = await pg.evaluate(() => ({ theme: window.__terminalOne.theme, style: window.__terminalOne.style }));
    assert(persisted.theme === 'gruvbox', 'theme persists across reload (gruvbox)');
    assert(persisted.style === 'floyd', 'style persists across reload (floyd)');

    await browser.close();
    browser = null;

    console.log('\nAll smoke + functional tests passed!');
    server.kill('SIGTERM');
    process.exit(0);
  } catch (err) {
    console.error('\n✗ ' + (err && err.message ? err.message : err));
    if (serverLog.trim()) console.error('--- server log ---\n' + serverLog.trim());
    try { if (browser) await browser.close(); } catch (_) {}
    server.kill('SIGTERM');
    process.exit(1);
  }
}

run();
