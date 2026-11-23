const { exec } = require('child_process');
const config = require('../../config');
const logger = require('../utils/logger');
const eventBus = require('../utils/eventBus');

class ShutdownController {
  constructor(verificationEngine, playwrightObserver) {
    this.verificationEngine = verificationEngine;
    this.playwrightObserver = playwrightObserver;

    this.countdownTimer = null;
    this.secondsRemaining = 0;
    this.gracePeriodSeconds = config.SAFETY.SHUTDOWN_GRACE_PERIOD_SECONDS;
    this.isCountdownActive = false;
    this.shutdownExecuted = false;

    this.bindEvents();
  }

  bindEvents() {
    eventBus.on('shutdown:ready', () => {
      this.initiateShutdownSequence();
    });

    eventBus.on('emergency:stop', () => {
      this.abortShutdown('Emergency Stop button pressed');
    });

    eventBus.on('action:disabled', () => {
      if (this.isCountdownActive) {
        this.abortShutdown('Action toggle turned off by user');
      }
    });

    // If user submits a new prompt at any time, immediately cancel active shutdown
    eventBus.on('prompt:detected', (data) => {
      if (this.isCountdownActive) {
        logger.safety('ShutdownController', `New prompt detected ("${data.prompt.slice(0, 50)}..."). Cancelling active shutdown countdown!`);
        this.abortShutdown('New user prompt detected in Antigravity');
      }
      this.shutdownExecuted = false;
    });
  }

  initiateShutdownSequence() {
    const vState = this.verificationEngine.getState();
    const action = vState.autoSleepEnabled ? 'SLEEP' : (vState.autoShutdownEnabled ? 'SHUTDOWN' : 'NONE');

    // Safety Gate 1: Check if an action is enabled
    if (action === 'NONE') {
      logger.safety('ShutdownController', 'Neither Auto-Shutdown nor Auto-Sleep is enabled. Keeping computer running.');
      return;
    }

    // Safety Gate 2: Check if emergency stop is active
    if (vState.isEmergencyStopped) {
      logger.safety('ShutdownController', 'Emergency Stop is active. Action blocked.');
      return;
    }

    // Safety Gate 3: Avoid double-trigger
    if (this.isCountdownActive || this.shutdownExecuted) {
      return;
    }

    logger.audit('ShutdownController', `Initiating ${action === 'SLEEP' ? 'sleep' : 'shutdown'} countdown (${this.gracePeriodSeconds}s grace period)...`, {
      action,
      prompt: vState.currentPrompt,
      dryRun: vState.dryRunMode
    });

    this.isCountdownActive = true;
    this.secondsRemaining = this.gracePeriodSeconds;
    this.verificationEngine.state.overallStatus = 'SHUTDOWN_COUNTDOWN';
    this.verificationEngine.emitState();

    // Tick countdown every second
    this.countdownTimer = setInterval(async () => {
      this.secondsRemaining -= 1;

      eventBus.emit('shutdown:tick', {
        secondsRemaining: this.secondsRemaining,
        dryRun: vState.dryRunMode,
        action
      });

      if (this.secondsRemaining <= 0) {
        clearInterval(this.countdownTimer);
        this.isCountdownActive = false;
        await this.executeShutdown();
      }
    }, 1000);
  }

  async closeAllBrowserTabs() {
    logger.info('ShutdownController', 'Closing all open browser tabs and windows (Chrome, Edge, Firefox, Brave, Opera)...');

    // 1. Playwright CDP cleanup if active
    if (this.playwrightObserver) {
      try {
        await this.playwrightObserver.closeAllBrowsers();
      } catch (_) {}
    }

    // 2. PowerShell graceful close first (sends WM_CLOSE to main windows)
    const psGracefulCmd = 'powershell -NoProfile -Command "Get-Process -Name chrome, msedge, brave, firefox, opera -ErrorAction SilentlyContinue | ForEach-Object { $_.CloseMainWindow() }"';
    await new Promise((resolve) => {
      exec(psGracefulCmd, { windowsHide: true }, () => resolve());
    });

    // Wait 1 second for tabs to gracefully flush and close
    await new Promise(r => setTimeout(r, 1000));

    // 3. Force-terminate all browser processes via PowerShell (Process.Kill)
    const psForceKillCmd = 'powershell -NoProfile -Command "Stop-Process -Name chrome, msedge, brave, firefox, opera -Force -ErrorAction SilentlyContinue"';
    await new Promise((resolve) => {
      exec(psForceKillCmd, { windowsHide: true }, () => resolve());
    });

    // 4. Force kill via taskkill /F /T to guarantee zero lingering background/GPU/renderer processes
    const browsers = ['chrome.exe', 'msedge.exe', 'brave.exe', 'firefox.exe', 'opera.exe'];
    for (const b of browsers) {
      await new Promise((resolve) => {
        exec(`taskkill /F /IM ${b} /T`, { windowsHide: true }, () => resolve());
      });
    }

    logger.success('ShutdownController', 'All browser tabs and windows closed successfully.');
  }

  async executeShutdown() {
    const vState = this.verificationEngine.getState();
    const action = vState.autoSleepEnabled ? 'SLEEP' : 'SHUTDOWN';

    logger.safety('ShutdownController', `Grace period ended. Beginning ${action.toLowerCase()} sequence...`);
    this.verificationEngine.state.overallStatus = 'SHUTDOWN_TRIGGERED';
    this.verificationEngine.emitState();

    // Step 1: For SHUTDOWN, close browser tabs cleanly.
    // For SLEEP: DO NOT close any tabs or windows! Keep user's active workspace and tabs intact as requested!
    if (action === 'SHUTDOWN') {
      await this.closeAllBrowserTabs();
    } else {
      logger.info('ShutdownController', 'Auto-Sleep active: preserving all open browser tabs, windows, and applications intact.');
    }

    this.shutdownExecuted = true;

    // For SLEEP: One-time trigger! Disarm Auto-Sleep and mark hasTriggeredSleep so it never triggers again in this session without manual reload/restart
    if (action === 'SLEEP' && this.verificationEngine) {
      logger.audit('ShutdownController', 'Auto-Sleep 1-time trigger executed. Auto-Sleep is now disarmed.');
      this.verificationEngine.state.autoSleepEnabled = false;
      this.verificationEngine.state.targetAction = 'NONE';
      this.verificationEngine.state.hasTriggeredSleep = true;
      this.verificationEngine.saveSettings();
      this.verificationEngine.emitState();
    }

    // Step 2: Execute OS Action or Safe Simulation
    if (vState.dryRunMode) {
      logger.audit('ShutdownController', `=== [DRY RUN / SAFE SIMULATION] === Computer ${action} successfully simulated! (PC will NOT power down/sleep in dry-run mode).`);
      eventBus.emit('shutdown:simulated', {
        action,
        prompt: vState.currentPrompt,
        timestamp: new Date().toISOString()
      });
    } else if (action === 'SLEEP') {
      logger.audit('ShutdownController', '=== [LIVE OS SLEEP] === Keeping all tabs open and putting Windows PC to sleep...');
      
      // Primary sleep command: SetSuspendState with force=true so no application can veto
      const sleepCmd = 'powershell -NoProfile -ExecutionPolicy Bypass -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Application]::SetSuspendState([System.Windows.Forms.PowerState]::Suspend, $true, $false)"';
      
      exec(sleepCmd, (err) => {
        if (err) {
          logger.warn('ShutdownController', `PowerShell primary sleep command failed: ${err.message}. Trying rundll32 fallback...`);
          // Secondary fallback: dispatch rundll32 SetSuspendState
          exec('rundll32.exe powrprof.dll,SetSuspendState 0,1,0', (rErr) => {
            if (rErr) {
              logger.error('ShutdownController', `Rundll32 sleep backup signal failed: ${rErr.message}`);
            } else {
              logger.info('ShutdownController', 'Rundll32 sleep backup signal dispatched.');
            }
          });
        } else {
          logger.success('ShutdownController', 'Windows sleep signal dispatched successfully.');
        }
      });
    } else {
      logger.audit('ShutdownController', '=== [LIVE OS SHUTDOWN] === All tabs closed. Executing Windows forced system shutdown command!');
      // Execute Windows forced shutdown command (/f forces apps to close so Windows doesn't stall)
      const shutdownCmd = 'shutdown /s /f /t 2 /c "Google Antigravity task verified and completed. All tabs closed. Shutting down."';
      exec(shutdownCmd, (err) => {
        if (err) {
          logger.warn('ShutdownController', `Windows shutdown command failed: ${err.message}. Trying PowerShell Stop-Computer fallback...`);
          exec('powershell -NoProfile -Command "Stop-Computer -Force"', (psErr) => {
            if (psErr) {
              logger.error('ShutdownController', `PowerShell Stop-Computer fallback failed: ${psErr.message}`);
            } else {
              logger.success('ShutdownController', 'PowerShell Stop-Computer signal dispatched successfully.');
            }
          });
          return;
        }
        logger.success('ShutdownController', 'Windows shutdown signal dispatched successfully.');
      });
    }
  }

  abortShutdown(reason = 'User aborted') {
    if (this.countdownTimer) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
    this.isCountdownActive = false;
    this.secondsRemaining = 0;
    this.shutdownExecuted = false;

    // Also run Windows abort command if a shutdown was queued
    exec('shutdown /a', () => {});

    logger.safety('ShutdownController', `Shutdown ABORTED! Reason: ${reason}`);
    eventBus.emit('shutdown:aborted', { reason });

    if (this.verificationEngine) {
      this.verificationEngine.state.overallStatus = 'ABORTED';
      this.verificationEngine.state.reasonsBlocked = [`Shutdown aborted: ${reason}`];
      this.verificationEngine.emitState();
    }
  }

  getCountdown() {
    return {
      isCountdownActive: this.isCountdownActive,
      secondsRemaining: this.secondsRemaining,
      gracePeriodSeconds: this.gracePeriodSeconds,
      shutdownExecuted: this.shutdownExecuted
    };
  }
}

module.exports = ShutdownController;
