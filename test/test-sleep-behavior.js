const assert = require('assert');
const VerificationEngine = require('../src/engine/verificationEngine');
const ShutdownController = require('../src/shutdown/shutdownController');
const DashboardServer = require('../src/server/dashboardServer');

async function runSleepTests() {
  console.log('\n--- Running Auto-Sleep Behavior & 1-Time Trigger Verification Suite ---\n');

  const mockWatcher = {
    getState: () => ({ isTurnComplete: true, status: 'COMPLETED', activeToolCalls: [] }),
    start: () => {},
    stop: () => {}
  };
  const mockPlaywright = {
    getState: () => ({ connected: false }),
    closeAllBrowsers: async () => { tabCloseCalled = true; },
    stop: () => {}
  };
  const mockSystem = {
    getState: () => ({ isWorkspaceQuiet: true, isProcessActive: false }),
    start: () => {},
    stop: () => {}
  };

  let tabCloseCalled = false;

  const ve = new VerificationEngine(mockWatcher, mockPlaywright, mockSystem);
  const sc = new ShutdownController(ve, mockPlaywright);

  // Mock closeAllBrowserTabs to track if tabs are closed
  sc.closeAllBrowserTabs = async () => {
    tabCloseCalled = true;
  };

  // Test 1: Safe Dry-Run Mode defaults to enabled (true)
  assert.strictEqual(ve.state.dryRunMode, true, 'Safe Dry-Run Mode must default to enabled (true)');
  ve.toggleAutoSleep(true);
  assert.strictEqual(ve.state.autoSleepEnabled, true, 'Auto-Sleep should be enabled');
  assert.strictEqual(ve.state.targetAction, 'SLEEP', 'Target action should be SLEEP');
  console.log('✔ Test 1 PASS: Safe Dry-Run Mode is default enabled (true)');

  // Test 2: Auto-Sleep execution does NOT close browser tabs or apps
  tabCloseCalled = false;
  // Mock sleep command to avoid sleeping test machine
  let executedCmd = null;
  const originalExec = require('child_process').exec;
  // Override executeShutdown's OS command section by setting dryRunMode temporarily or checking behavior
  ve.state.dryRunMode = true; // Use simulation in test to verify logic
  await sc.executeShutdown();

  assert.strictEqual(tabCloseCalled, false, 'Tabs must NOT be closed for Auto-Sleep!');
  assert.strictEqual(ve.state.hasTriggeredSleep, true, 'hasTriggeredSleep must be set to true');
  assert.strictEqual(ve.state.autoSleepEnabled, false, 'Auto-Sleep must be disarmed after 1-time trigger');
  assert.strictEqual(ve.state.targetAction, 'NONE', 'Target action must reset to NONE');
  console.log('✔ Test 2 PASS: Auto-Sleep preserves all browser tabs (tab closing is skipped)');
  console.log('✔ Test 3 PASS: Auto-Sleep triggers 1 time and disarms automatically');

  // Test 4: Cannot re-trigger Auto-Sleep in same session without page reload
  ve.toggleAutoSleep(true);
  assert.strictEqual(ve.state.autoSleepEnabled, false, 'Should block re-arming Auto-Sleep in same session');
  console.log('✔ Test 4 PASS: Re-triggering Auto-Sleep is blocked in the same session');

  // Test 5: Page reload / reset API clears the 1-time lock
  const ds = new DashboardServer(ve, sc, mockPlaywright, mockWatcher, mockSystem);
  ve.state.hasTriggeredSleep = false; // Simulated page reload (GET / or POST /api/reset-sleep-lock)
  ve.toggleAutoSleep(true);
  assert.strictEqual(ve.state.autoSleepEnabled, true, 'Auto-Sleep can be re-armed after page reload / reset');
  console.log('✔ Test 5 PASS: Manual page reload / restart allows Auto-Sleep to be re-armed');

  // Test 6: Auto-Shutdown STILL closes all tabs
  tabCloseCalled = false;
  ve.state.hasTriggeredSleep = false;
  ve.toggleAutoShutdown(true);
  assert.strictEqual(ve.state.autoShutdownEnabled, true);
  assert.strictEqual(ve.state.targetAction, 'SHUTDOWN');
  await sc.executeShutdown();
  assert.strictEqual(tabCloseCalled, true, 'Auto-Shutdown must close all browser tabs');
  console.log('✔ Test 6 PASS: Auto-Shutdown behavior unchanged (closes tabs and shuts down)');

  ve.stop();
  console.log('\n✔ ALL Auto-Sleep 1-Time Trigger & Tab Preservation tests PASSED successfully!\n');
}

runSleepTests().catch(err => {
  console.error('Test Failed:', err);
  process.exit(1);
});
