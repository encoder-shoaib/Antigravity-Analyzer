const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const TranscriptWatcher = require('../src/monitor/transcriptWatcher');
const PlaywrightObserver = require('../src/monitor/playwrightObserver');
const SystemWatcher = require('../src/monitor/systemWatcher');
const VerificationEngine = require('../src/engine/verificationEngine');
const ShutdownController = require('../src/shutdown/shutdownController');
const DashboardServer = require('../src/server/dashboardServer');
const config = require('../config');

// Override port for testing
config.PORT = 4399;

async function runBrowserE2ETest() {
  console.log('\n--- Running Browser End-to-End & UI Verification Test ---');

  // Create isolated temp brain directory
  const testBrainDir = path.join(__dirname, 'mock_brain_e2e');
  const testConvDir = path.join(testBrainDir, 'test-e2e-session', '.system_generated', 'logs');
  fs.mkdirSync(testConvDir, { recursive: true });
  const transcriptPath = path.join(testConvDir, 'transcript.jsonl');
  fs.writeFileSync(transcriptPath, '');

  const tw = new TranscriptWatcher(testBrainDir);
  const po = new PlaywrightObserver();
  po.state.connected = false;
  const sw = new SystemWatcher();
  sw.state.isWorkspaceQuiet = true;
  sw.state.isProcessActive = false;

  const ve = new VerificationEngine(tw, po, sw);
  ve.state.cooldownTargetSeconds = 2; // Fast 2s cooldown
  ve.state.autoShutdownEnabled = false;
  ve.state.autoSleepEnabled = false;
  ve.state.dryRunMode = true;

  const sc = new ShutdownController(ve, po);
  sc.gracePeriodSeconds = 5;

  const ds = new DashboardServer(ve, sc, po, tw, sw);

  tw.start();
  ve.start();
  await ds.start();
  console.log('✔ Test Dashboard Server started on port 4399');

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const consoleErrors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
    }
  });

  page.on('pageerror', err => {
    consoleErrors.push(err.message);
  });

  try {
    await page.goto('http://localhost:4399', { waitUntil: 'networkidle' });
    console.log('✔ Page loaded successfully');

    // 1. Verify NO JS errors occurred
    if (consoleErrors.length > 0) {
      throw new Error(`Browser console errors detected: ${JSON.stringify(consoleErrors)}`);
    }
    console.log('✔ Zero console / runtime errors in browser');

    // 2. Verify Connected state
    const connText = await page.textContent('#connLabel');
    if (connText !== 'Connected') {
      throw new Error(`Expected #connLabel to be "Connected", got: "${connText}"`);
    }
    console.log('✔ Connection indicator verified: Connected');

    // 3. Verify Terminal Stream is rendering logs
    const eventsText = await page.textContent('#termEventsCount');
    console.log(`✔ Terminal events count: "${eventsText}"`);
    if (!eventsText.includes('events logged')) {
      throw new Error(`Expected #termEventsCount to contain "events logged", got "${eventsText}"`);
    }

    const termHtml = await page.innerHTML('#terminalScreen');
    if (!termHtml.includes('[') || !termHtml.includes(']')) {
      throw new Error('Terminal screen did not render log badges!');
    }
    console.log('✔ Terminal stream successfully rendered formatted log badges');

    // 4. Test Toggling Auto-Shutdown
    await page.click('#toggleAutoShutdown', { force: true });
    await page.waitForTimeout(400);
    const modeTitle = await page.textContent('#tileModeTitle');
    console.log(`✔ After Auto-Shutdown click, TileModeTitle: "${modeTitle}"`);
    if (!modeTitle.includes('Auto-Shutdown')) {
      throw new Error(`Expected tileModeTitle to mention Auto-Shutdown, got "${modeTitle}"`);
    }

    // 5. Test Toggling Auto-Sleep (Mutual Exclusivity)
    await page.click('#toggleAutoSleep', { force: true });
    await page.waitForTimeout(400);
    const modeTitle2 = await page.textContent('#tileModeTitle');
    console.log(`✔ After Auto-Sleep click, TileModeTitle: "${modeTitle2}"`);
    if (!modeTitle2.includes('Auto-Sleep')) {
      throw new Error(`Expected tileModeTitle to mention Auto-Sleep, got "${modeTitle2}"`);
    }

    const isShutdownChecked = await page.isChecked('#toggleAutoShutdown');
    if (isShutdownChecked) {
      throw new Error('Expected Auto-Shutdown to be unchecked when Auto-Sleep is enabled');
    }
    console.log('✔ Mutual exclusivity verified: Auto-Shutdown unchecked when Auto-Sleep checked');

    // Turn off Auto-Sleep so we start in MONITOR ONLY mode
    await page.click('#toggleAutoSleep', { force: true });
    await page.waitForTimeout(400);

    // 6. Test Prompt Execution Flow
    console.log('Simulating real prompt flow via transcript file...');
    fs.appendFileSync(transcriptPath, JSON.stringify({
      step_index: 1,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      created_at: new Date().toISOString(),
      content: '<USER_REQUEST>Execute system performance audit</USER_REQUEST>'
    }) + '\n');

    await page.waitForTimeout(700);
    const executingStatus = await page.textContent('#tileStatusText');
    console.log(`✔ Prompt detected in UI, status: "${executingStatus}"`);

    // Model tool execution
    fs.appendFileSync(transcriptPath, JSON.stringify({
      step_index: 2,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      created_at: new Date().toISOString(),
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'audit --quick' } }]
    }) + '\n');

    await page.waitForTimeout(700);

    // Model turn completion
    fs.appendFileSync(transcriptPath, JSON.stringify({
      step_index: 3,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      created_at: new Date().toISOString(),
      tool_calls: [],
      content: 'Audit completed successfully!'
    }) + '\n');

    // Wait for prompt finish
    await page.waitForTimeout(1500);

    // Status should be STANDBY or COMPLETED with action mode OFF
    const completedStatus = await page.textContent('#tileStatusText');
    console.log(`✔ Prompt finished & verified, UI status: "${completedStatus}"`);
    if (completedStatus !== 'COMPLETED' && completedStatus !== 'STANDBY') {
      throw new Error(`Expected status COMPLETED or STANDBY, got "${completedStatus}"`);
    }

    // 7. Post-completion arming: User now flips Auto-Shutdown switch ON!
    console.log('User arms Auto-Shutdown on already completed task...');
    await page.click('#toggleAutoShutdown', { force: true });
    await page.waitForTimeout(3000);

    const isCountdownCardVisible = await page.isVisible('#shutdownCountdownCard');
    console.log(`✔ After arming Auto-Shutdown, countdown card visible: ${isCountdownCardVisible}`);
    if (!isCountdownCardVisible) {
      throw new Error('Expected #shutdownCountdownCard to be visible after arming completed task!');
    }

    // 8. Test Stop Shutdown button
    await page.click('#btnAbortCountdown');
    await page.waitForTimeout(500);
    const isCountdownHidden = !(await page.isVisible('#shutdownCountdownCard'));
    console.log(`✔ After clicking Stop Shutdown, countdown card hidden: ${isCountdownHidden}`);
    if (!isCountdownHidden) {
      throw new Error('Expected countdown card to be hidden after clicking Stop Shutdown');
    }

    console.log('\n✔ ALL Browser End-to-End & UI Verification checks PASSED successfully!\n');
  } finally {
    await browser.close();
    tw.stop();
    ve.stop();
    ds.stop();
    try {
      fs.rmSync(testBrainDir, { recursive: true, force: true });
    } catch (_) {}
    // Restore default production settings
    fs.writeFileSync(path.join(__dirname, '..', 'settings.json'), JSON.stringify({
      autoShutdownEnabled: false,
      autoSleepEnabled: false,
      targetAction: 'NONE',
      dryRunMode: false,
      manualConfirmationMode: false,
      cooldownTargetSeconds: 20
    }, null, 2), 'utf8');
  }
}

runBrowserE2ETest().catch(err => {
  console.error('\n✖ Browser E2E Test FAILED:', err.message);
  process.exit(1);
});
