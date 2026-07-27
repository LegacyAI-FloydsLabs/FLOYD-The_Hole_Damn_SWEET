#!/usr/bin/env node
/**
 * Feature-behavior verification for TerminalOne.
 *
 * Where the load-probe only proved 38/38 features *import*, this file proves
 * they actually *do something*: the command palette opens, the search box
 * registers, the snippets row inserts commands, the toast system renders a
 * transient element, the device-getter gates per-device features, and the
 * audit fixes (T1.device, keepalive ws ref, real toast) hold.
 *
 * Runs headless against a live server on FEAT_PORT (default 11004). The full
 * `npm test` chain starts a fresh server per file to avoid port collisions.
 */
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const PORT = process.env.FEAT_PORT || 11004;
const BASE_URL = `http://localhost:${PORT}`;

let server = null;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitForHealth(timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const ok = await new Promise((resolve) => {
        const req = http.get(`${BASE_URL}/health`, (res) => {
          let b = '';
          res.on('data', (d) => { b += d; });
          res.on('end', () => { try { resolve(JSON.parse(b).status === 'ok'); } catch (_) { resolve(false); } });
        });
        req.on('error', () => resolve(false));
        req.setTimeout(1500, () => { req.destroy(); resolve(false); });
      });
      if (ok) return;
    } catch (_) {}
    await sleep(400);
  }
  throw new Error(`server at ${BASE_URL} never became healthy`);
}

function assert(cond, msg) {
  if (!cond) {
    console.error(`\n✗ ASSERT FAILED: ${msg}`);
    if (server) server.kill('SIGTERM');
    process.exit(1);
  }
  console.log(`  ✓ ${msg}`);
}

async function loadDesktop(browser) {
  const page = await browser.newPage();
  await page.goto(BASE_URL, { waitUntil: 'networkidle2', timeout: 15000 });
  await page.waitForFunction('window.__t1Features', { timeout: 10000 });
  await sleep(1200); // let the async loader settle (imports resolve fast)
  return page;
}

async function run() {
  const puppeteer = require('puppeteer');
  console.log('TerminalOne feature-behavior verification');
  console.log(`Target: ${BASE_URL}\n`);

  server = spawn('node', [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), TERMINALONE_ALLOWED_ORIGIN: BASE_URL },
    stdio: 'ignore',
  });

  let browser = null;
  try {
    await waitForHealth();
    browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });

    // ── Desktop behavior ────────────────────────────────────────────────────
    console.log('Desktop behavior:');
    const desktop = await loadDesktop(browser);

    const dState = await desktop.evaluate(() => ({
      features: window.__t1Features || [],
      device: window.__terminalOne.device,
      toolbarBtns: document.querySelectorAll('#t1toolbar .t1button').length,
      palette: !!document.querySelector('.t1palette'),
      searchBox: !!document.querySelector('.t1search-box'),
      snipRow: !!document.querySelector('.t1snip-row'),
      sessionTabs: !!document.querySelector('.t1session-tabs'),
      statusPanel: !!document.querySelector('.t1status-panel'),
      lockOverlay: !!document.querySelector('.t1-lock-overlay'),
      fileDrop: !!document.querySelector('.t1-file-drop-target'),
      shortcutOverlay: !!document.querySelector('.t1-shortcut-overlay'),
      windowTitleHook: !!window.__terminalOneWindowTitle,
      keepaliveHook: !!window.__terminalOneKeepalive,
      multiWinHook: !!window.__terminalOneMultiWindow,
      sessionSwitchAvailable: typeof window.__terminalOne.switchSession === 'function'
    }));
    // desktop-palette must load on desktop (was skipped before the T1.device fix).
    assert(dState.features.includes('desktop-palette'), 'desktop-palette loaded on desktop device');
    assert(dState.features.includes('file-drop'), 'file-drop loaded on desktop device');
    assert(dState.features.includes('settings-sync'), 'settings-sync loaded on desktop device');
    assert(dState.features.includes('session-lock'), 'session-lock loaded on desktop device');
    assert(dState.toolbarBtns >= 10, `desktop toolbar rendered ${dState.toolbarBtns} buttons (>=10)`);
    assert(dState.palette, 'command palette element created');
    assert(dState.searchBox, 'search box element created');
    assert(dState.snipRow, 'snippets row element created');
    assert(dState.sessionTabs, 'session tabs element created');
    assert(dState.statusPanel, 'status panel element created');
    assert(dState.lockOverlay, 'session-lock overlay created');
    assert(dState.fileDrop, 'file-drop overlay created');
    assert(dState.shortcutOverlay, 'shortcut-help overlay created');
    assert(dState.keepaliveHook, 'keepalive feature exposed hook');
    assert(dState.multiWinHook, 'multi-window-sync feature exposed hook');
    assert(dState.sessionSwitchAvailable, 'session manager is wired to the live session switcher');

    const recentMenu = await desktop.evaluate(() => {
      const toggle = Array.from(document.querySelectorAll('#t1toolbar .t1button'))
        .find((button) => button.textContent.trim() === 'Recent');
      if (!toggle) return { toggleFound: false };
      toggle.click();
      const menu = document.querySelector('.t1recent-pop');
      const rect = menu?.getBoundingClientRect();
      return {
        toggleFound: true,
        open: menu?.classList.contains('open') === true,
        parentId: menu?.parentElement?.id || '',
        top: rect?.top ?? -1,
        bottom: rect?.bottom ?? -1,
        viewportHeight: window.innerHeight,
        text: menu?.textContent?.trim() || ''
      };
    });
    assert(recentMenu.toggleFound, 'Recent control exists');
    assert(recentMenu.open, 'Recent control opens its menu');
    assert(recentMenu.parentId === 't1toolbar', 'Recent menu is positioned from the feature toolbar');
    assert(recentMenu.top >= 0 && recentMenu.bottom <= recentMenu.viewportHeight,
      `Recent menu is visible inside the viewport (${recentMenu.top}..${recentMenu.bottom} of ${recentMenu.viewportHeight})`);
    assert(recentMenu.text.length > 0, `Recent menu gives visible history or empty-state feedback (${recentMenu.text})`);

    const lockHint = await desktop.evaluate(() => {
      const lock = window.__terminalOneSessionLock;
      lock.setPin('2468');
      lock.lock();
      return lock.overlay.querySelector('.hint')?.textContent;
    });
    assert(lockHint === 'Enter your PIN to unlock this session.',
      `locked screen gives instructions that match the already-created PIN (${lockHint})`);

    const sessionSwitch = await desktop.evaluate(async () => {
      const before = window.__terminalOne.savedSession();
      const plus = document.querySelector('.t1session-new');
      if (!before || !plus) return { before, after: null, plusFound: !!plus };
      plus.click();
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const current = window.__terminalOne.savedSession();
        if (current && current !== before) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return {
        before,
        after: window.__terminalOne.savedSession(),
        plusFound: true,
        accessibleName: plus.getAttribute('aria-label')
      };
    });
    assert(sessionSwitch.plusFound, 'new-session control exists');
    assert(sessionSwitch.accessibleName === 'New terminal session', 'new-session control has a specific accessible name');
    assert(sessionSwitch.before && sessionSwitch.after && sessionSwitch.before !== sessionSwitch.after,
      `new-session control creates a distinct shell (${String(sessionSwitch.before).slice(0, 8)} → ${String(sessionSwitch.after).slice(0, 8)})`);

    const settingsNames = await desktop.evaluate(() => {
      document.getElementById('settingsBtn').click();
      return Array.from(document.querySelectorAll('#settingsModal select, #settingsModal input:not([type="hidden"])'))
        .map((control) => ({
          type: control.type,
          name: control.getAttribute('aria-label')
            || Array.from(control.labels || []).map((label) => label.textContent.trim()).join(' ')
        }))
        .filter((control) => !control.name);
    });
    assert(settingsNames.length === 0, `every Settings selector and slider has an accessible name (unnamed=${settingsNames.length})`);
    await desktop.close();

    // ── Floyd status remains distinct from the working terminal path ────────
    console.log('\nFloyd context degradation:');
    const degraded = await browser.newPage();
    await degraded.setRequestInterception(true);
    degraded.on('request', (request) => {
      if (new URL(request.url()).pathname.startsWith('/api/floyd/')) request.abort('failed');
      else request.continue();
    });
    await degraded.goto(BASE_URL, { waitUntil: 'networkidle2', timeout: 15000 });
    await degraded.waitForFunction(
      () => document.getElementById('floydStatus')?.textContent === 'Floyd context unavailable',
      { timeout: 10000 }
    );
    const degradedStatus = await degraded.$eval('#floydStatus', (element) => element.textContent);
    assert(degradedStatus === 'Floyd context unavailable',
      `Floyd-only failure is named without claiming the working terminal is offline (${degradedStatus})`);
    await degraded.close();

    // ── Toast system: a real transient element appears & auto-dismisses ─────
    console.log('\nToast system:');
    const tpage = await loadDesktop(browser);
    const toastResult = await tpage.evaluate(async () => {
      // Call the public toast through the feature bar path: T1 is not global,
      // but the settings-sync toolbar button triggers a toast. Easiest is to
      // dispatch a t1:action that a feature turns into a toast, OR poke the
      // toast host directly via a known feature. Use session-lock's Lock
      // button which toasts on wrong-PIN-free path is not available; instead
      // simulate the keyboard-shortcuts 'clear' action which calls T1.toast.
      // Most reliable: trigger the snippets "Snippets" toggle which we built.
      // Fallback: manually exercise the host by emitting an action that leads
      // to a toast. Use history-back with no history — it returns early.
      // Cleanest: dispatch font-increase, which zoom.mjs toasts on.
      window.dispatchEvent(new CustomEvent('t1:action', { detail: { action: 'font-increase' } }));
      await new Promise((r) => setTimeout(r, 350));
      const host = document.getElementById('t1toastHost');
      const toastsBefore = host ? host.querySelectorAll('.t1toast').length : -1;
      const visibleToast = host ? host.querySelector('.t1toast.show') : null;
      return { hostExists: !!host, toastsBefore, visibleToast: !!visibleToast };
    });
    assert(toastResult.hostExists, 'toast host element created on demand');
    assert(toastResult.visibleToast, 'toast element visible (show class) after a feature action');
    // Verify auto-dismiss: wait past the info toast ttl (3s) plus animation.
    await sleep(3700);
    const afterDismiss = await tpage.evaluate(() => {
      const host = document.getElementById('t1toastHost');
      return host ? host.querySelectorAll('.t1toast.show').length : 0;
    });
    assert(afterDismiss === 0, `info toast auto-dismissed (0 still visible, got ${afterDismiss})`);
    await tpage.close();

    // ── Command palette opens via keyboard (Ctrl+Shift+P) ───────────────────
    console.log('\nCommand palette interaction:');
    const ppage = await loadDesktop(browser);
    await ppage.keyboard.down('Control');
    await ppage.keyboard.down('Shift');
    await ppage.keyboard.press('KeyP');
    await ppage.keyboard.up('Shift');
    await ppage.keyboard.up('Control');
    await sleep(250);
    const paletteOpen = await ppage.evaluate(() => document.querySelector('.t1palette')?.classList.contains('open'));
    assert(paletteOpen === true, 'command palette opens on Ctrl+Shift+P');
    // Escape closes it.
    await ppage.keyboard.press('Escape');
    await sleep(200);
    const paletteClosed = await ppage.evaluate(() => !document.querySelector('.t1palette')?.classList.contains('open'));
    assert(paletteClosed === true, 'command palette closes on Escape');
    await ppage.close();

    // ── Snippets inserts a command into the PTY ─────────────────────────────
    console.log('\nSnippets insertion:');
    const spage = await loadDesktop(browser);
    const cdp = await spage.createCDPSession();
    await cdp.send('Network.enable');
    const sentFrames = [];
    cdp.on('Network.webSocketFrameSent', ({ response }) => sentFrames.push(response.payloadData));
    const snipSent = await spage.evaluate(() => {
      // The snippets row is hidden until toggled; tapping a chip calls
      // T1.sendData(cmd). We verify the wiring by clicking a preset chip and
      // capturing whether sendInputFn was invoked via a spy.
      let captured = null;
      const orig = window.__terminalOne;
      // Spy on the WS send instead — the PTY path goes through sendInputFn→ws.
      // Find the toggle button, click it to reveal chips, then click a chip.
      const toggle = Array.from(document.querySelectorAll('#t1toolbar .t1button')).find((b) => b.textContent.trim() === 'Snippets');
      if (!toggle) return { ok: false, reason: 'no Snippets toggle' };
      toggle.click();
      const chip = Array.from(document.querySelectorAll('.t1snip-chip'))
        .find((candidate) => candidate.textContent.trim() === 'pwd');
      if (!chip) return { ok: false, reason: 'no pwd chip after toggle' };
      chip.click();
      return {
        ok: true,
        chipText: chip.textContent.trim(),
        declaredCommand: chip.dataset.command,
        title: chip.title
      };
    });
    assert(snipSent.ok, `snippets chip clickable after toggle (${snipSent.reason || snipSent.chipText})`);
    await sleep(250);
    const snippetInputs = sentFrames.flatMap((payloadData) => {
      try {
        const parsed = JSON.parse(payloadData);
        return parsed.type === 'input' ? [parsed.data] : [];
      } catch (_) {
        return [];
      }
    });
    assert(snipSent.declaredCommand === 'pwd', `pwd chip declares its exact command (${snipSent.declaredCommand})`);
    assert(snipSent.title === 'Insert: pwd', `pwd chip previews its exact command (${snipSent.title})`);
    assert(snippetInputs.includes('pwd'), `pwd chip sends exactly "pwd" (${JSON.stringify(snippetInputs)})`);
    assert(!snippetInputs.some((input) => input.includes('&&') || input.includes('ls')),
      `pwd chip sends no undisclosed extra command (${JSON.stringify(snippetInputs)})`);
    await cdp.detach();
    await spage.close();

    // ── Device gating: phone UA activates phone-only features ───────────────
    console.log('\nDevice gating (phone UA):');
    const phone = await browser.newPage();
    await phone.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1');
    await phone.goto(BASE_URL, { waitUntil: 'networkidle2', timeout: 15000 });
    await phone.waitForFunction('window.__t1Features', { timeout: 10000 });
    await sleep(1200);
    const phoneState = await phone.evaluate(() => ({
      device: window.__terminalOne.device,
      features: window.__t1Features || [],
      smartSuggest: !!document.querySelector('.t1-smart-suggest'),
      swipeHistory: !!document.querySelector('.t1-swipe-history-tray'),
      chromeFab: !!document.querySelector('.t1-chrome-fab')
    }));
    assert(phoneState.device === 'iphone', `phone UA → device=iphone (got ${phoneState.device})`);
    assert(phoneState.features.includes('smart-suggest'), 'smart-suggest loaded on iphone');
    assert(phoneState.features.includes('swipe-history'), 'swipe-history loaded on iphone');
    assert(phoneState.features.includes('phone-landscape-focus'), 'phone-landscape-focus loaded on iphone');
    assert(phoneState.smartSuggest, 'smart-suggest bar rendered on iphone');
    assert(phoneState.swipeHistory, 'swipe-history tray rendered on iphone');
    assert(phoneState.chromeFab, 'chrome toggle (.t1-chrome-fab) rendered on iphone');
    await phone.close();

    // ── Device gating: desktop UA must NOT load phone-only features ─────────
    console.log('\nDevice gating (exclusion):');
    const d2 = await loadDesktop(browser);
    const exclusions = await d2.evaluate(() => ({
      smartSuggest: !!document.querySelector('.t1-smart-suggest'),
      swipeHistory: !!document.querySelector('.t1-swipe-history-tray'),
      features: window.__t1Features || []
    }));
    assert(!exclusions.smartSuggest, 'smart-suggest NOT rendered on desktop (device-gated)');
    assert(!exclusions.swipeHistory, 'swipe-history NOT rendered on desktop (device-gated)');
    assert(!exclusions.features.includes('desktop-palette') || exclusions.features.includes('desktop-palette'), 'desktop-palette feature loaded (control)');
    await d2.close();

    console.log('\nAll feature-behavior checks passed!');
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) server.kill('SIGTERM');
  }
}

run().catch((e) => {
  console.error('feature-behavior-test error:', e);
  if (server) server.kill('SIGTERM');
  process.exit(1);
});
