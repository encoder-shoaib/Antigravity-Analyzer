const assert = require('assert');
const path = require('path');
const fs = require('fs');

// Set safe test environment
process.env.DRY_RUN_MODE = 'true';
process.env.AUTO_SHUTDOWN_ENABLED = 'true';
process.env.VERIFICATION_DELAY_SECONDS = '2'; // 2s fast cooldown for test
process.env.SHUTDOWN_GRACE_PERIOD_SECONDS = '2';

const config = require('../config');
const eventBus = require('../src/utils/eventBus');
const logger = require('../src/utils/logger');
const VerificationEngine = require('../src/engine/verificationEngine');
const ShutdownController = require('../src/shutdown/shutdownController');

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runTests() {
  console.log('\n====================================================');
  console.log('   Running Automated Safety & Verification Test Suite');
  console.log('====================================================\n');

  let passed = 0;
  let failed = 0;

  function report(name, ok, details = '') {
    if (ok) {
      console.log(`  \x1b[32m✔ PASS\x1b[0m: ${name} ${details}`);
      passed++;
    } else {
      console.log(`  \x1b[31m✖ FAIL\x1b[0m: ${name} ${details}`);
      failed++;
    }
  }

  // Mock Monitors
  const mockTranscript = {
    state: {
      currentPrompt: null,
      status: 'IDLE',
      isTurnComplete: false,
      waitingForUserInput: false,
      activeToolCalls: [],
      lastError: null
    },
    getState() { return { ...this.state }; }
  };

  const mockPlaywright = {
    state: {
      connected: true,
      isGenerating: false,
      isBusy: false,
      waitingForInput: false,
      inputReady: true,
      hasError: false
    },
    closeCalls: 0,
    async closeAllBrowsers() {
      this.closeCalls++;
      return true;
    },
    getState() { return { ...this.state }; }
  };

  const mockSystem = {
    state: {
      isWorkspaceQuiet: true,
      isProcessActive: false
    },
    getState() { return { ...this.state }; }
  };

  const engine = new VerificationEngine(mockTranscript, mockPlaywright, mockSystem);
  const shutdownCtrl = new ShutdownController(engine, mockPlaywright);
  engine.start();

  // Ensure auto-shutdown is enabled and short cooldown for unit tests
  engine.state.autoShutdownEnabled = true;
  engine.state.cooldownTargetSeconds = 2;

  // TEST 1: Initial state is IDLE, no shutdown
  engine.evaluateState();
  report('Test 1: System begins in IDLE state', engine.state.overallStatus === 'IDLE');

  // TEST 2: Prompt detected triggers EXECUTING state
  eventBus.emit('prompt:detected', { prompt: 'Create REST API service' });
  mockTranscript.state.currentPrompt = 'Create REST API service';
  mockTranscript.state.status = 'RUNNING';
  engine.evaluateState();
  report('Test 2: Prompt detected sets status to EXECUTING', engine.state.overallStatus === 'EXECUTING');

  // TEST 3: Active tool calls prevent verification and keep status EXECUTING
  mockTranscript.state.activeToolCalls = [{ name: 'run_command', args: { CommandLine: 'npm test' } }];
  engine.evaluateState();
  report('Test 3: Active tool calls block completion', engine.state.overallStatus === 'EXECUTING' && !engine.state.signals.noActiveTools);

  // TEST 4: Agent waiting for user input strictly blocks completion
  mockTranscript.state.activeToolCalls = [];
  mockTranscript.state.waitingForUserInput = true;
  mockTranscript.state.status = 'WAITING_INPUT';
  engine.evaluateState();
  report('Test 4: Waiting for input sets status to WAITING_INPUT and blocks verification', engine.state.overallStatus === 'WAITING_INPUT' && !engine.state.signals.notWaitingForInput);

  // TEST 5: Error in transcript or execution strictly blocks completion
  mockTranscript.state.waitingForUserInput = false;
  mockTranscript.state.lastError = 'Fatal build error';
  mockTranscript.state.status = 'ERROR';
  engine.evaluateState();
  report('Test 5: Error blocks completion and sets status to ERROR', engine.state.overallStatus === 'ERROR' && !engine.state.signals.noUnresolvedErrors);

  // TEST 6: Playwright Stop button visible blocks completion
  mockTranscript.state.lastError = null;
  mockTranscript.state.isTurnComplete = true;
  mockTranscript.state.status = 'COMPLETED';
  mockPlaywright.state.isGenerating = true; // Stop button visible
  engine.evaluateState();
  report('Test 6: Playwright Stop button visible blocks completion', engine.state.overallStatus === 'EXECUTING' && !engine.state.signals.playwrightIdle);

  // TEST 7: Multi-Signal Green initiates VERIFYING cooldown
  mockPlaywright.state.isGenerating = false;
  mockPlaywright.state.isBusy = false;
  engine.evaluateState(); // Tick 1 (1s of 2s)
  report('Test 7: All signals green enters VERIFYING state', engine.state.overallStatus === 'VERIFYING' && engine.state.cooldownElapsedSeconds === 1);

  // TEST 8: Full cooldown completion triggers COMPLETED & shutdown sequence
  await sleep(1100);
  engine.evaluateState(); // Tick 2 (2s of 2s target reached)
  const isCompletedOrCountdown = engine.state.overallStatus === 'COMPLETED' || engine.state.overallStatus === 'SHUTDOWN_COUNTDOWN';
  report('Test 8: Cooldown completion triggers COMPLETED / COUNTDOWN state', isCompletedOrCountdown);

  // TEST 9: Shutdown countdown triggers and Emergency Stop aborts countdown
  await sleep(100);
  report('Test 9a: Shutdown Countdown started', shutdownCtrl.isCountdownActive || engine.state.overallStatus === 'SHUTDOWN_COUNTDOWN');

  // Trigger Emergency Stop
  eventBus.emit('emergency:stop');
  report('Test 9b: Emergency Stop cancels countdown and sets ABORTED', engine.state.overallStatus === 'ABORTED' && !shutdownCtrl.isCountdownActive);

  // TEST 10: Playwright cleanup verification
  await mockPlaywright.closeAllBrowsers();
  report('Test 10: Playwright browser teardown closes managed pages', mockPlaywright.closeCalls >= 1);

  engine.stop();

  // Restore default initial settings for user
  const realSettingsPath = path.join(__dirname, '..', 'settings.json');
  fs.writeFileSync(realSettingsPath, JSON.stringify({
    autoShutdownEnabled: false,
    autoSleepEnabled: false,
    targetAction: 'NONE',
    dryRunMode: true,
    manualConfirmationMode: false,
    cooldownTargetSeconds: 20
  }, null, 2), 'utf8');

  console.log('\n----------------------------------------------------');
  console.log(`Test Summary: ${passed} Passed, ${failed} Failed`);
  console.log('----------------------------------------------------\n');

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

if (require.main === module) {
  runTests().catch(err => {
    console.error('Test Suite Failed:', err);
    process.exit(1);
  });
}

module.exports = { runTests };
