#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const puppeteer = require('puppeteer');
const { HARNESSES } = require('../src/harnesses');

// Puppeteer's own download may be absent; fall back to a system browser.
function findChrome() {
  const fs = require('node:fs');
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return undefined; // let puppeteer try its bundled browser
}

const PORT = 11016;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(PORT) },
  stdio: ['ignore', 'ignore', 'inherit'],
});

function waitForHealth() {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const probe = () => {
      const request = http.get(`${BASE_URL}/health`, (response) => {
        response.resume();
        if (response.statusCode === 200) return resolve();
        retry();
      });
      request.on('error', retry);
    };
    const retry = () => {
      if (Date.now() - started > 10_000) return reject(new Error('launcher did not become healthy'));
      setTimeout(probe, 100);
    };
    probe();
  });
}

async function main() {
  let browser;
  try {
    await waitForHealth();
    browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || findChrome(),
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await browser.newPage();
    await page.goto(BASE_URL, { waitUntil: 'networkidle0', timeout: 15_000 });
    await page.waitForSelector('.harness-card');

    const cards = await page.evaluate(() => Array.from(document.querySelectorAll('.harness-card')).map((card) => ({
      tag: card.tagName,
      type: card.getAttribute('type'),
      name: card.getAttribute('aria-label'),
      harness: card.dataset.harness,
      tabIndex: card.tabIndex,
    })));
    assert.equal(cards.length, HARNESSES.length);
    for (const card of cards) {
      assert.equal(card.tag, 'BUTTON', `${card.harness} card is a native button`);
      assert.equal(card.type, 'button', `${card.harness} card has a safe button type`);
      assert.equal(card.name, `Launch ${card.harness} harness`, `${card.harness} card has a specific accessible name`);
      assert.equal(card.tabIndex, 0, `${card.harness} card is keyboard-focusable`);
    }

    const focused = await page.evaluate(() => {
      const first = document.querySelector('.harness-card');
      window.__keyboardHarnessActivation = null;
      first.addEventListener('click', (event) => {
        event.stopImmediatePropagation();
        window.__keyboardHarnessActivation = first.dataset.harness;
      }, { capture: true, once: true });
      first.focus();
      return { harness: first.dataset.harness, focused: document.activeElement === first };
    });
    assert.equal(focused.focused, true, 'a harness button accepts focus');
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => window.__keyboardHarnessActivation), focused.harness,
      'Enter activates the focused harness button');

    console.log(`PASS ${cards.length} named, keyboard-operable harness buttons`);
  } finally {
    if (browser) await browser.close();
    child.kill('SIGTERM');
  }
}

main().catch((error) => {
  child.kill('SIGTERM');
  console.error(error);
  process.exitCode = 1;
});
