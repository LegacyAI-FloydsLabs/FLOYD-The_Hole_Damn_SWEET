#!/usr/bin/env node
/**
 * Smoke Test — Full User Journey
 * Exercises the actual workflow a human user would follow,
 * captures screenshots at each step as evidence.
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'http://localhost:11000';
const SCREENSHOT_DIR = path.join(__dirname, 'smoke-test-evidence');

async function run() {
  // Prepare evidence directory
  if (fs.existsSync(SCREENSHOT_DIR)) {
    fs.rmSync(SCREENSHOT_DIR, { recursive: true });
  }
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1400,900']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });

  const evidence = [];
  let stepNum = 0;

  async function screenshot(name) {
    stepNum++;
    const filename = `${String(stepNum).padStart(2, '0')}-${name}.png`;
    const filepath = path.join(SCREENSHOT_DIR, filename);
    await page.screenshot({ path: filepath, fullPage: false });
    evidence.push({ step: stepNum, name, file: filename });
    console.log(`  [Step ${stepNum}] Screenshot: ${filename}`);
  }

  try {
    // ================================================================
    // STEP 1: Load the launcher page
    // ================================================================
    console.log('\n[1] Loading launcher page...');
    await page.goto(BASE_URL, { waitUntil: 'networkidle0', timeout: 10000 });
    await screenshot('launcher-page-loaded');

    // Verify: 14 harness cards present
    const cards = await page.$$('.harness-card');
    console.log(`  Found ${cards.length} harness cards (expected 14)`);
    if (cards.length !== 14) {
      throw new Error(`Expected 14 harness cards, found ${cards.length}`);
    }

    // Verify: welcome screen visible
    const welcomeVisible = await page.evaluate(() => {
      const ws = document.getElementById('welcomeScreen');
      return ws && ws.style.display !== 'none';
    });
    console.log(`  Welcome screen visible: ${welcomeVisible}`);

    // Verify: header text
    const headerText = await page.evaluate(() => {
      return document.querySelector('.header h1')?.textContent;
    });
    console.log(`  Header: "${headerText}"`);

    // ================================================================
    // STEP 2: Click "omp" harness card — launch first terminal
    // ================================================================
    console.log('\n[2] Clicking "omp" harness card...');
    const ompCard = await page.evaluateHandle(() => {
      const cards = document.querySelectorAll('.harness-card');
      return Array.from(cards).find(c => c.querySelector('.card-title')?.textContent === 'omp');
    });
    await ompCard.click();
    await new Promise(r => setTimeout(r, 2000));
    await screenshot('omp-launched');

    // Verify: welcome screen hidden
    const welcomeHidden = await page.evaluate(() => {
      const ws = document.getElementById('welcomeScreen');
      return ws && ws.style.display === 'none';
    });
    console.log(`  Welcome screen hidden: ${welcomeHidden}`);

    // Verify: xterm terminal exists and has content
    const xtermState = await page.evaluate(() => {
      const termEl = document.getElementById('terminal');
      const xtermEl = termEl?.querySelector('.xterm');
      if (!xtermEl) return { exists: false };
      const rows = xtermEl.querySelectorAll('.xterm-rows > div');
      const textContent = Array.from(rows).map(r => r.textContent).join('\n');
      return {
        exists: true,
        rows: rows.length,
        hasContent: textContent.length > 0,
        contentPreview: textContent.substring(0, 300)
      };
    });
    console.log(`  xterm.js present: ${xtermState.exists}`);
    console.log(`  Terminal rows: ${xtermState.rows}`);
    console.log(`  Has content: ${xtermState.hasContent}`);
    if (xtermState.contentPreview) {
      console.log(`  Content preview: ${JSON.stringify(xtermState.contentPreview.substring(0, 150))}`);
    }

    // Verify: status shows connected
    const statusText = await page.evaluate(() => {
      return document.querySelector('.terminal-status')?.textContent;
    });
    console.log(`  Status: "${statusText}"`);

    // Verify: card marked active
    const activeCard = await page.evaluate(() => {
      const active = document.querySelector('.harness-card.active .card-title');
      return active?.textContent;
    });
    console.log(`  Active card: "${activeCard}"`);

    // ================================================================
    // STEP 3: Wait for more output, then take screenshot of terminal
    // ================================================================
    console.log('\n[3] Waiting for terminal output to accumulate...');
    await new Promise(r => setTimeout(r, 3000));
    await screenshot('omp-terminal-output');

    // Check terminal has substantial output
    const outputState = await page.evaluate(() => {
      const termEl = document.getElementById('terminal');
      const rows = termEl?.querySelectorAll('.xterm-rows > div') || [];
      const allText = Array.from(rows).map(r => r.textContent).join('');
      return {
        rowCount: rows.length,
        totalChars: allText.length,
        hasAnsiColors: termEl?.innerHTML?.includes('xterm-color') || false,
        hasCursor: termEl?.querySelector('.xterm-cursor') !== null
      };
    });
    console.log(`  Terminal rows: ${outputState.rowCount}`);
    console.log(`  Total chars: ${outputState.totalChars}`);
    console.log(`  Has ANSI colors: ${outputState.hasAnsiColors}`);
    console.log(`  Cursor visible: ${outputState.hasCursor}`);

    // ================================================================
    // STEP 4: Type input into the terminal
    // ================================================================
    console.log('\n[4] Sending keyboard input to terminal...');
    // Click on the terminal to focus it
    const termEl = await page.$('#terminal');
    await termEl.click();
    await new Promise(r => setTimeout(r, 300));
    await page.keyboard.type('echo "hello from smoke test"');
    await page.keyboard.press('Enter');
    await new Promise(r => setTimeout(r, 2000));
    await screenshot('omp-with-input');

    const afterInput = await page.evaluate(() => {
      const rows = document.querySelectorAll('#terminal .xterm-rows > div');
      const allText = Array.from(rows).map(r => r.textContent).join('\n');
      return allText.includes('hello from smoke test');
    });
    console.log(`  Input echoed back: ${afterInput}`);

    // ================================================================
    // STEP 5: Close the session
    // ================================================================
    console.log('\n[5] Closing terminal session...');
    await page.click('#closeBtn');
    await new Promise(r => setTimeout(r, 1000));
    await screenshot('session-closed');

    const afterClose = await page.evaluate(() => {
      const welcomeVis = document.getElementById('welcomeScreen')?.style.display !== 'none';
      const termHidden = document.getElementById('terminal')?.style.display === 'none';
      const btnHidden = document.getElementById('closeBtn')?.style.display === 'none';
      const noActive = document.querySelector('.harness-card.active') === null;
      return { welcomeVis, termHidden, btnHidden, noActive };
    });
    console.log(`  Welcome screen restored: ${afterClose.welcomeVis}`);
    console.log(`  Terminal hidden: ${afterClose.termHidden}`);
    console.log(`  Close button hidden: ${afterClose.btnHidden}`);
    console.log(`  No active card: ${afterClose.noActive}`);

    // ================================================================
    // STEP 6: Launch a second harness (sf — Go binary, different type)
    // ================================================================
    console.log('\n[6] Launching "sf" (Go binary) harness...');
    const sfCard = await page.evaluateHandle(() => {
      const cards = document.querySelectorAll('.harness-card');
      return Array.from(cards).find(c => c.querySelector('.card-title')?.textContent === 'sf');
    });
    await sfCard.click();
    await new Promise(r => setTimeout(r, 3000));
    await screenshot('sf-launched');

    const sfState = await page.evaluate(() => {
      const termEl = document.getElementById('terminal');
      const xtermEl = termEl?.querySelector('.xterm');
      const rows = xtermEl?.querySelectorAll('.xterm-rows > div') || [];
      const allText = Array.from(rows).map(r => r.textContent).join('');
      const status = document.querySelector('.terminal-status')?.textContent;
      const activeTitle = document.querySelector('.harness-card.active .card-title')?.textContent;
      return {
        terminalVisible: termEl?.style.display !== 'none',
        xtermPresent: !!xtermEl,
        rows: rows.length,
        hasContent: allText.length > 0,
        contentPreview: allText.substring(0, 200),
        status,
        activeCard: activeTitle
      };
    });
    console.log(`  Terminal visible: ${sfState.terminalVisible}`);
    console.log(`  xterm.js present: ${sfState.xtermPresent}`);
    console.log(`  Status: "${sfState.status}"`);
    console.log(`  Active card: "${sfState.activeCard}"`);
    console.log(`  Rows: ${sfState.rows}, has content: ${sfState.hasContent}`);

    // ================================================================
    // STEP 7: Final screenshot with sf running
    // ================================================================
    await new Promise(r => setTimeout(r, 2000));
    await screenshot('sf-running-final');

    // ================================================================
    // Clean up
    // ================================================================
    console.log('\n[7] Closing browser...');
    await browser.close();

    // ================================================================
    // Summary
    // ================================================================
    console.log('\n' + '='.repeat(60));
    console.log('SMOKE TEST EVIDENCE SUMMARY');
    console.log('='.repeat(60));
    evidence.forEach(e => {
      console.log(`  Step ${e.step}: ${e.name} -> ${e.file}`);
    });
    console.log('='.repeat(60));

    const allPassed =
      cards.length === 14 &&
      welcomeVisible &&
      welcomeHidden &&
      xtermState.exists &&
      xtermState.hasContent &&
      outputState.totalChars > 50 &&
      afterClose.welcomeVis &&
      afterClose.noActive &&
      sfState.terminalVisible &&
      sfState.xtermPresent &&
      sfState.hasContent;

    console.log(`\nResult: ${allPassed ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED'}`);
    process.exit(allPassed ? 0 : 1);

  } catch (err) {
    console.error('SMOKE TEST FAILED:', err.message);
    await screenshot('error-state');
    await browser.close();
    process.exit(1);
  }
}

run();
