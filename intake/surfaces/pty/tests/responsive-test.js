#!/usr/bin/env node
/**
 * Responsive layout verification for TerminalOne.
 *
 * Reproduces the reported defect ("the app exceeds the viewport of my iPad")
 * and proves the fix: across a matrix of real iPad / tablet viewport sizes the
 * app shell must fit entirely within the viewport with zero overflow, the key
 * bar / footer must be visible (not clipped), and the on-screen key bar must
 * reflow for the narrow Split-View column.
 *
 * Sizes covered (CSS px @ 2x DPR, portrait + landscape):
 *   - iPad mini 6      744×1133
 *   - iPad 10th        820×1180
 *   - iPad Air / Pro   820×1180, 1024×1366
 *   - iPad Pro 12.9"   1024×1366
 *   - Split View (narrow iPad column) 320×1024, 507×1024, 520×1024
 *   - Landscape        1133×744, 1180×820, 1366×1024
 *   - iPhone SE / 15 / 15 Pro Max (portrait + landscape) — chrome toggle + control bar
 */

const path = require('path');
const { spawn } = require('child_process');
const http = require('http');

const PORT = process.env.RESP_PORT || 11003;
const BASE_URL = `http://localhost:${PORT}`;

const VIEWPORTS = [
  // ── The user's actual device: iPad (A16, 11th gen, 2025) — 10.86", 820×1180 CSS pt ──
  { name: 'iPad A16 11th-gen (portrait)',  width: 820,  height: 1180, dpr: 2, ua: 'ipad-portrait' },
  { name: 'iPad A16 11th-gen (landscape)', width: 1180, height: 820,  dpr: 2, ua: 'ipad-landscape' },
  { name: 'iPad A16 11th-gen Split 1/3',   width: 320,  height: 820,  dpr: 2, ua: 'ipad-portrait' },
  { name: 'iPad A16 11th-gen Split 1/2',   width: 512,  height: 820,  dpr: 2, ua: 'ipad-portrait' },
  { name: 'iPad mini 6 (portrait)',      width: 744,  height: 1133, dpr: 2, ua: 'ipad-portrait' },
  { name: 'iPad mini 6 (landscape)',     width: 1133, height: 744,  dpr: 2, ua: 'ipad-landscape' },
  { name: 'iPad Pro 11" (portrait)',     width: 834,  height: 1194, dpr: 2, ua: 'ipad-portrait' },
  { name: 'iPad Pro 12.9" (portrait)',   width: 1024, height: 1366, dpr: 2, ua: 'ipad-portrait' },
  { name: 'iPad Pro 12.9" (landscape)',  width: 1366, height: 1024, dpr: 2, ua: 'ipad-landscape' },
  { name: 'Slide Over (narrow column)',  width: 438,  height: 1024, dpr: 2, ua: 'ipad-portrait' }
];

// iPadOS 13+ UA — reports MacIntel but requests desktop; combined with touch
// this is what detectDevice() keys off of for the iPad key bar.
const IPAD_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

// Real iPhone Safari UA — detectDevice() keys off /iPhone/ for the iphone key bar.
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const IPHONE_VIEWPORTS = [
  { name: 'iPhone SE (portrait)',          width: 375, height: 667, dpr: 2 },
  { name: 'iPhone SE (landscape)',         width: 667, height: 375, dpr: 2 },
  { name: 'iPhone 15 (portrait)',          width: 393, height: 852, dpr: 3 },
  { name: 'iPhone 15 (landscape)',         width: 852, height: 393, dpr: 3 },
  { name: 'iPhone 15 Pro Max (portrait)',  width: 430, height: 932, dpr: 3 },
  { name: 'iPhone 15 Pro Max (landscape)', width: 932, height: 430, dpr: 3 }
];

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT FAILED: ' + msg);
  console.log('  ✓ ' + msg);
}

function get(p) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${BASE_URL}${p}`, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('timeout')));
  });
}

async function waitForHealth(timeoutMs = 20000) {
  const start = Date.now();
  for (;;) {
    try {
      const r = await get('/health');
      if (r.statusCode === 200) { JSON.parse(r.body); return; }
    } catch (_) { /* not up yet */ }
    if (Date.now() - start > timeoutMs) throw new Error('server did not become healthy');
    await new Promise((r) => setTimeout(r, 250));
  }
}

// Per-viewport: emulate an iPad, load the app, and measure overflow.
async function checkViewport(browser, vp) {
  const pg = await browser.newPage();
  try {
    await pg.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: vp.dpr, hasTouch: true, isMobile: true });
    await pg.setUserAgent(IPAD_UA);
    await pg.evaluateOnNewDocument(() => {
      // iPadOS reports MacIntel + maxTouchPoints>1 — the detectDevice() trigger.
      Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' });
      Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 2 });
    });
    await pg.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await pg.waitForFunction('window.__terminalOne', { timeout: 10000 });
    // Let the terminal + first fit settle.
    await new Promise((r) => setTimeout(r, 500));

    const m = await pg.evaluate(() => {
      const sh = document.querySelector('.app-shell');
      const cont = document.querySelector('.terminal-container');
      const keybar = document.querySelector('#keybarIpad');
      const footer = document.querySelector('.terminal-footer');
      const header = document.querySelector('.terminal-header');
      const term = document.querySelector('#terminal');
      // DOMRect values live on the prototype, so {...rect} (own-props only)
      // yields an empty object — copy each field explicitly.
      const rect = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
      };
      const shellStyle = getComputedStyle(sh);
      return {
        vw: window.innerWidth,
        vh: window.innerHeight,
        device: document.body.dataset.device,
        shell: rect(sh),
        shellHeight: parseFloat(shellStyle.height),
        shellWidth: parseFloat(shellStyle.width),
        shellBox: shellStyle.boxSizing,
        shellPadding: shellStyle.padding,
        container: rect(cont),
        header: rect(header),
        keybar: keybar ? { ...rect(keybar), display: getComputedStyle(keybar).display } : null,
        footer: rect(footer),
        term: rect(term),
        // documentElement scroll size reveals ANY content overflow.
        docScrollW: document.documentElement.scrollWidth,
        docScrollH: document.documentElement.scrollHeight,
        bodyScrollW: document.body.scrollWidth,
        bodyScrollH: document.body.scrollHeight
      };
    });

    // The core assertion: the app must NOT exceed the viewport.
    const hOverflow = m.docScrollH - m.vh;
    const wOverflow = m.docScrollW - m.vw;
    assert(m.device === 'ipad', `${vp.name}: detectDevice → ipad (got ${m.device})`);
    assert(hOverflow <= 1, `${vp.name}: no vertical overflow (scrollH=${m.docScrollH} ≤ vh=${m.vh}, over=${hOverflow})`);
    assert(wOverflow <= 1, `${vp.name}: no horizontal overflow (scrollW=${m.docScrollW} ≤ vw=${m.vw}, over=${wOverflow})`);

    // The key bar + footer must be fully inside the viewport (the symptom of
    // the bug was the bottom controls being clipped off-screen).
    assert(m.keybar && m.keybar.bottom <= m.vh + 1, `${vp.name}: iPad key bar within viewport (bottom=${Math.round(m.keybar.bottom)} ≤ ${m.vh})`);
    assert(m.footer.bottom <= m.vh + 1, `${vp.name}: footer within viewport (bottom=${Math.round(m.footer.bottom)} ≤ ${m.vh})`);
    assert(m.container.bottom >= 0 && m.container.top < m.vh, `${vp.name}: terminal container visible (top=${Math.round(m.container.top)}, bottom=${Math.round(m.container.bottom)})`);

    // The shell must use the dynamic-viewport height (dvh) when supported —
    // proving the layout tracks mobile chrome rather than the static large vh.
    assert(m.shellBox === 'border-box', `${vp.name}: app-shell is border-box (insets don't compound)`);

    // Terminal element itself must be fully contained (xterm canvas not clipped).
    assert(m.term.bottom <= m.vh + 1 && m.term.right <= m.vw + 1, `${vp.name}: xterm element contained (term bottom=${Math.round(m.term.bottom)}, right=${Math.round(m.term.right)})`);

    // R1/R3: the chrome toggle must be on-screen and a >=44pt target on iPad too.
    await pg.waitForFunction(() => !!document.querySelector('.t1-chrome-fab'), { timeout: 8000 });
    const fabM = await pg.evaluate(() => {
      const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, width: b.width, height: b.height, display: getComputedStyle(el).display }; };
      return { fab: r(document.querySelector('.t1-chrome-fab')), key: r(document.querySelector('#keybarIpad .kb-key') || document.querySelector('.kb-key')), vw: window.innerWidth, vh: window.innerHeight };
    });
    assert(fabM.fab && fabM.fab.display !== 'none', `${vp.name}: chrome toggle present`);
    assert(fabM.fab.left >= -1 && fabM.fab.right <= fabM.vw + 1, `${vp.name}: chrome toggle within viewport X (left=${Math.round(fabM.fab.left)}, right=${Math.round(fabM.fab.right)}, vw=${fabM.vw})`);
    assert(fabM.fab.top >= -1 && fabM.fab.bottom <= fabM.vh + 1, `${vp.name}: chrome toggle within viewport Y (top=${Math.round(fabM.fab.top)}, bottom=${Math.round(fabM.fab.bottom)})`);
    assert(fabM.fab.width >= 44 && fabM.fab.height >= 44, `${vp.name}: chrome toggle >=44pt (${Math.round(fabM.fab.width)}x${Math.round(fabM.fab.height)})`);
    assert(fabM.key && fabM.key.height >= 44, `${vp.name}: keybar key >=44pt tall (${Math.round(fabM.key.height)})`);
  } finally {
    await pg.close();
  }
}

// Per-iPhone-viewport: emulate an iPhone, load the app, and prove the chrome
// toggle is reachable on-screen and the control bar (keybar) stays visible —
// including when the chrome is collapsed for more terminal space.
async function checkIphone(browser, vp) {
  const pg = await browser.newPage();
  try {
    await pg.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: vp.dpr, hasTouch: true, isMobile: true });
    await pg.setUserAgent(IPHONE_UA);
    await pg.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await pg.waitForFunction('window.__terminalOne', { timeout: 10000 });
    await pg.waitForFunction(() => !!document.querySelector('.t1-chrome-fab'), { timeout: 10000 });
    await new Promise((r) => setTimeout(r, 300));

    const m = await pg.evaluate(() => {
      const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, width: b.width, height: b.height, display: getComputedStyle(el).display }; };
      return {
        vw: window.innerWidth, vh: window.innerHeight,
        device: document.body.dataset.device,
        fab: r(document.querySelector('.t1-chrome-fab')),
        keybar: r(document.querySelector('#keybarIphone')),
        key: r(document.querySelector('#keybarIphone .kb-key')),
        footer: r(document.querySelector('.terminal-footer')),
        docScrollW: document.documentElement.scrollWidth,
        docScrollH: document.documentElement.scrollHeight
      };
    });

    assert(m.device === 'iphone', `${vp.name}: detectDevice → iphone (got ${m.device})`);
    assert(m.docScrollW - m.vw <= 1, `${vp.name}: no horizontal overflow (scrollW=${m.docScrollW} ≤ vw=${m.vw})`);
    assert(m.docScrollH - m.vh <= 1, `${vp.name}: no vertical overflow (scrollH=${m.docScrollH} ≤ vh=${m.vh})`);
    // R1: chrome toggle on-screen at any size (the off-screen-right bug).
    assert(m.fab && m.fab.display !== 'none', `${vp.name}: chrome toggle present`);
    assert(m.fab.left >= -1 && m.fab.right <= m.vw + 1, `${vp.name}: chrome toggle within viewport X (left=${Math.round(m.fab.left)}, right=${Math.round(m.fab.right)}, vw=${m.vw})`);
    assert(m.fab.top >= -1 && m.fab.bottom <= m.vh + 1, `${vp.name}: chrome toggle within viewport Y (top=${Math.round(m.fab.top)}, bottom=${Math.round(m.fab.bottom)}, vh=${m.vh})`);
    // R3: 44pt touch targets.
    assert(m.fab.width >= 44 && m.fab.height >= 44, `${vp.name}: chrome toggle >=44pt (${Math.round(m.fab.width)}x${Math.round(m.fab.height)})`);
    assert(m.key && m.key.height >= 44, `${vp.name}: keybar key >=44pt tall (${Math.round(m.key.height)})`);
    // R2: control bar visible + within viewport.
    assert(m.keybar && m.keybar.display === 'flex', `${vp.name}: control bar (keybar) visible`);
    assert(m.keybar.bottom <= m.vh + 1, `${vp.name}: control bar within viewport (bottom=${Math.round(m.keybar.bottom)} ≤ ${m.vh})`);
    assert(m.footer.bottom <= m.vh + 1, `${vp.name}: footer within viewport (bottom=${Math.round(m.footer.bottom)} ≤ ${m.vh})`);

    // R2 under collapse: hiding chrome must NOT hide the control bar.
    const collapsed = await pg.evaluate(() => {
      window.__terminalOneChrome.setCollapsed(true);
      const kb = document.querySelector('#keybarIphone');
      const hd = document.querySelector('.terminal-header');
      const out = { keybarDisplay: getComputedStyle(kb).display, keybarBottom: kb.getBoundingClientRect().bottom, headerHidden: getComputedStyle(hd).display === 'none', vh: window.innerHeight };
      window.__terminalOneChrome.setCollapsed(false);
      return out;
    });
    assert(collapsed.keybarDisplay === 'flex', `${vp.name}: control bar STAYS visible when chrome collapsed`);
    assert(collapsed.keybarBottom <= collapsed.vh + 1, `${vp.name}: control bar within viewport when collapsed`);
    assert(collapsed.headerHidden, `${vp.name}: header hidden when collapsed (terminal gains space)`);
  } finally {
    await pg.close();
  }
}

async function run() {
  console.log('TerminalOne responsive layout verification');
  console.log(`Target: ${BASE_URL}\n`);

  const server = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), TERMINALONE_ALLOWED_ORIGIN: BASE_URL },
    stdio: 'ignore'
  });
  let browser = null;
  try {
    await waitForHealth();

    const puppeteer = require('puppeteer');
    browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });

    // RESP_DEVICE=ipad|iphone runs a subset (each browser load is ~1.3s; the
    // harness caps a single command at 30s, so subsets keep receipts complete).
    const only = process.env.RESP_DEVICE || '';
    if (only !== 'iphone') {
      for (const vp of VIEWPORTS) {
        console.log(`\n[${vp.name}] ${vp.width}×${vp.height} @${vp.dpr}x`);
        await checkViewport(browser, vp);
      }
    }
    if (only !== 'ipad') {
      for (const vp of IPHONE_VIEWPORTS) {
        console.log(`\n[${vp.name}] ${vp.width}×${vp.height} @${vp.dpr}x`);
        await checkIphone(browser, vp);
      }
    }

    console.log('\nAll responsive layout checks passed!');
    server.kill('SIGTERM');
    process.exit(0);
  } catch (err) {
    console.error('\n✗ ' + (err && err.message ? err.message : err));
    try { if (browser) await browser.close(); } catch (_) {}
    server.kill('SIGTERM');
    process.exit(1);
  }
}

run();
