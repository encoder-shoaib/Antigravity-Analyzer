const assert = require('assert');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const eventBus = require('../src/utils/eventBus');
const TranscriptWatcher = require('../src/monitor/transcriptWatcher');
const VerificationEngine = require('../src/engine/verificationEngine');
const ShutdownController = require('../src/shutdown/shutdownController');
const SystemWatcher = require('../src/monitor/systemWatcher');
const PlaywrightObserver = require('../src/monitor/playwrightObserver');

async function testScenario() {
  console.log('\n--- Running Live Prompt-to-Shutdown Simulation Test ---');

  // Create isolated temp brain directory
  const testBrainDir = path.join(__dirname, 'mock_brain_live');
  const testConvDir = path.join(testBrainDir, 'test-conv-session', '.system_generated', 'logs');
  fs.mkdirSync(testConvDir, { recursive: true });
  const transcriptPath = path.join(testConvDir, 'transcript.jsonl');
  fs.writeFileSync(transcriptPath, '');

  const tw = new TranscriptWatcher(testBrainDir);
  const pw = new PlaywrightObserver();
  pw.state.connected = false; // transcript + process mode
  const sw = new SystemWatcher();
  sw.state.isWorkspaceQuiet = true;
  sw.state.isProcessActive = false;

  const ve = new VerificationEngine(tw, pw, sw);
  ve.state.cooldownTargetSeconds = 3; // 3 seconds cooldown for test speed
  ve.state.autoShutdownEnabled = true;
  ve.state.dryRunMode = true;

  const sc = new ShutdownController(ve, pw);
  sc.gracePeriodSeconds = 5; // 5 seconds grace period for test speed

  tw.start();
  ve.start();

  // 1. User submits a prompt
  console.log('1. Submitting user prompt...');
  const promptEntry = JSON.stringify({
    step_index: 1,
    source: 'USER_EXPLICIT',
    type: 'USER_INPUT',
    created_at: new Date().toISOString(),
    content: '<USER_REQUEST>Build a web scraper</USER_REQUEST>'
  }) + '\n';
  fs.appendFileSync(transcriptPath, promptEntry);

  await new Promise(r => setTimeout(r, 600));
  assert.strictEqual(ve.state.overallStatus, 'EXECUTING');
  console.log('   Status:', ve.state.overallStatus, '(Expected EXECUTING)');

  // 2. Model executes tool call
  console.log('2. Model running tool...');
  const toolEntry = JSON.stringify({
    step_index: 2,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    created_at: new Date().toISOString(),
    tool_calls: [{ name: 'run_command', args: { CommandLine: 'npm install cheerio' } }]
  }) + '\n';
  fs.appendFileSync(transcriptPath, toolEntry);

  await new Promise(r => setTimeout(r, 600));
  assert.strictEqual(ve.state.overallStatus, 'EXECUTING');
  console.log('   Status during tool:', ve.state.overallStatus, '(Expected EXECUTING)');

  // 3. Model finishes execution with final response
  console.log('3. Model finishes execution (100% complete)...');
  const finishEntry = JSON.stringify({
    step_index: 3,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    created_at: new Date().toISOString(),
    content: 'All tasks completed successfully!'
  }) + '\n';
  fs.appendFileSync(transcriptPath, finishEntry);

  // 4. Wait for stabilization delay (3s)
  console.log('4. Waiting for stabilization cooldown (3s)...');
  await new Promise(r => setTimeout(r, 4000));

  console.log('   Status after stabilization:', ve.state.overallStatus);
  console.log('   Countdown active:', sc.isCountdownActive);
  assert.strictEqual(sc.isCountdownActive, true, 'Countdown should be active!');

  // 5. Test Emergency Stop cancels countdown
  console.log('5. Clicking EMERGENCY STOP...');
  eventBus.emit('emergency:stop');
  await new Promise(r => setTimeout(r, 200));

  assert.strictEqual(sc.isCountdownActive, false, 'Countdown should be stopped!');
  assert.strictEqual(ve.state.overallStatus, 'ABORTED');
  console.log('   Status after Emergency Stop:', ve.state.overallStatus);

  // 6. Test Auto-Sleep mode transition
  console.log('6. Testing Auto-Sleep mode toggle...');
  ve.toggleAutoSleep(true);
  assert.strictEqual(ve.state.autoSleepEnabled, true);
  assert.strictEqual(ve.state.autoShutdownEnabled, false);
  assert.strictEqual(ve.state.targetAction, 'SLEEP');
  console.log('   Target action:', ve.state.targetAction, '(Expected SLEEP)');

  // Cleanup
  tw.stop();
  ve.stop();
  sw.stop();
  pw.stop();
  fs.rmSync(testBrainDir, { recursive: true, force: true });

  // Restore default initial settings for user
  const realSettingsPath = path.join(__dirname, '..', 'settings.json');
  fs.writeFileSync(realSettingsPath, JSON.stringify({
    autoShutdownEnabled: false,
    autoSleepEnabled: false,
    targetAction: 'NONE',
    dryRunMode: false,
    manualConfirmationMode: false,
    cooldownTargetSeconds: 20
  }, null, 2), 'utf8');

  console.log('\n✔ Live Prompt-to-Shutdown & Auto-Sleep Simulation PASSED completely!\n');
}

testScenario().catch(err => {
  console.error('Test Failed:', err);
  process.exit(1);
});
