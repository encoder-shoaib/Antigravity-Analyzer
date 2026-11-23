const fs = require('fs');
const path = require('path');
const config = require('../../config');
const logger = require('../utils/logger');
const eventBus = require('../utils/eventBus');

const SETTINGS_FILE = path.join(__dirname, '..', '..', 'settings.json');

class VerificationEngine {
  constructor(transcriptWatcher, playwrightObserver, systemWatcher) {
    this.transcriptWatcher = transcriptWatcher;
    this.playwrightObserver = playwrightObserver;
    this.systemWatcher = systemWatcher;

    const savedSettings = this.loadSettings();

    this.state = {
      overallStatus: 'IDLE', // IDLE, EXECUTING, WAITING_INPUT, VERIFYING, COMPLETED, CONFIRMATION_PENDING, SHUTDOWN_COUNTDOWN, SHUTDOWN_TRIGGERED, ABORTED, ERROR
      currentPrompt: null,
      promptStartTime: null,
      cooldownElapsedSeconds: 0,
      cooldownTargetSeconds: savedSettings.cooldownTargetSeconds || config.SAFETY.VERIFICATION_DELAY_SECONDS,
      signals: {
        transcriptDone: false,
        noActiveTools: true,
        playwrightIdle: true,
        notWaitingForInput: true,
        noUnresolvedErrors: true,
        workspaceQuiet: true
      },
      verificationProgressPercent: 0,
      isEmergencyStopped: false,
      autoShutdownEnabled: typeof savedSettings.autoShutdownEnabled === 'boolean' ? savedSettings.autoShutdownEnabled : false,
      autoSleepEnabled: typeof savedSettings.autoSleepEnabled === 'boolean' ? savedSettings.autoSleepEnabled : false,
      targetAction: savedSettings.autoSleepEnabled ? 'SLEEP' : (savedSettings.autoShutdownEnabled ? 'SHUTDOWN' : 'NONE'),
      dryRunMode: typeof savedSettings.dryRunMode === 'boolean' ? savedSettings.dryRunMode : true,
      manualConfirmationMode: typeof savedSettings.manualConfirmationMode === 'boolean' ? savedSettings.manualConfirmationMode : config.SAFETY.MANUAL_CONFIRMATION_MODE,
      hasTriggeredSleep: false,
      reasonsBlocked: [],
      lastDecisionTimestamp: null
    };

    this.ticker = null;
    this.consecutiveStableSeconds = 0;
    this.executionTimeoutTimer = null;
  }

  loadSettings() {
    try {
      if (fs.existsSync(SETTINGS_FILE)) {
        const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
        return JSON.parse(raw);
      }
    } catch (_) {}
    return {};
  }

  saveSettings() {
    try {
      const data = {
        autoShutdownEnabled: this.state.autoShutdownEnabled,
        autoSleepEnabled: this.state.autoSleepEnabled,
        targetAction: this.state.targetAction,
        dryRunMode: this.state.dryRunMode,
        manualConfirmationMode: this.state.manualConfirmationMode,
        cooldownTargetSeconds: this.state.cooldownTargetSeconds
      };
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
      logger.warn('VerificationEngine', `Failed to save settings: ${err.message}`);
    }
  }

  start() {
    logger.info('VerificationEngine', 'Starting Safety & Multi-Gate Verification Engine...');
    this.bindEvents();

    // Run evaluation tick every 1000ms
    this.ticker = setInterval(() => {
      this.evaluateState();
    }, 1000);

    return this;
  }

  bindEvents() {
    eventBus.on('prompt:detected', (data) => {
      this.state.currentPrompt = data.prompt;
      this.state.promptStartTime = Date.now();
      this.state.overallStatus = 'EXECUTING';
      this.state.isEmergencyStopped = false;
      this.consecutiveStableSeconds = 0;
      this.state.cooldownElapsedSeconds = 0;
      this.state.verificationProgressPercent = 0;
      this.state.reasonsBlocked = ['Agent execution in progress'];

      // Start maximum execution timeout check
      this.resetExecutionTimeout();
    });

    eventBus.on('agent:waiting_input', () => {
      this.consecutiveStableSeconds = 0;
      this.state.overallStatus = 'WAITING_INPUT';
      this.state.reasonsBlocked = ['Agent is waiting for user input or approval'];
    });

    eventBus.on('error:detected', (data) => {
      this.consecutiveStableSeconds = 0;
      this.state.overallStatus = 'ERROR';
      this.state.reasonsBlocked = [`Error detected: ${data.error}`];
      logger.safety('VerificationEngine', `Shutdown blocked due to error: ${data.error}`);
    });

    eventBus.on('emergency:stop', () => {
      this.emergencyStop();
    });
  }

  resetExecutionTimeout() {
    if (this.executionTimeoutTimer) clearTimeout(this.executionTimeoutTimer);
    const timeoutMs = config.SAFETY.MAX_EXECUTION_TIMEOUT_MINUTES * 60 * 1000;
    this.executionTimeoutTimer = setTimeout(() => {
      if (this.state.overallStatus === 'EXECUTING' || this.state.overallStatus === 'VERIFYING') {
        logger.safety('VerificationEngine', `Execution timeout (${config.SAFETY.MAX_EXECUTION_TIMEOUT_MINUTES} min) exceeded! Halting shutdown.`);
        this.state.overallStatus = 'ERROR';
        this.state.reasonsBlocked = ['Execution exceeded safety timeout limit'];
        eventBus.emit('execution:timeout');
      }
    }, timeoutMs);
  }

  evaluateState() {
    if (this.state.isEmergencyStopped) {
      this.state.overallStatus = 'ABORTED';
      this.state.reasonsBlocked = ['Emergency Stop is active'];
      this.emitState();
      return;
    }

    if (this.state.overallStatus === 'SHUTDOWN_COUNTDOWN' || this.state.overallStatus === 'SHUTDOWN_TRIGGERED') {
      // Shutdown sequence already taken over by shutdown controller
      this.emitState();
      return;
    }

    if (this.state.overallStatus === 'ABORTED' && !this.state.autoShutdownEnabled && !this.state.autoSleepEnabled) {
      this.emitState();
      return;
    }

    const tState = this.transcriptWatcher ? this.transcriptWatcher.getState() : {};
    const pState = this.playwrightObserver ? this.playwrightObserver.getState() : {};
    const sState = this.systemWatcher ? this.systemWatcher.getState() : {};

    // Check if there is an active prompt being tracked
    if (!this.state.currentPrompt && tState.currentPrompt) {
      this.state.currentPrompt = tState.currentPrompt;
      this.state.promptStartTime = Date.now();
    }

    if (!this.state.currentPrompt) {
      this.state.overallStatus = 'IDLE';
      this.state.reasonsBlocked = ['No prompt submitted yet'];
      this.emitState();
      return;
    }

    // 1. Evaluate Signal 1: Transcript Turn Done
    const transcriptDone = Boolean(tState.isTurnComplete && tState.status === 'COMPLETED');

    // 2. Evaluate Signal 2: No Active Tool Calls
    const noActiveTools = !tState.activeToolCalls || tState.activeToolCalls.length === 0;

    // 3. Evaluate Signal 3: Playwright DOM Idle
    // If CDP is connected, verify no Stop button, no busy spinner, input ready
    // If CDP is not connected, fallback to transcript + system signals
    let playwrightIdle = true;
    if (pState.connected) {
      playwrightIdle = !pState.isGenerating && !pState.isBusy && !pState.waitingForInput;
    }

    // 4. Evaluate Signal 4: NOT Waiting for Input
    const notWaitingForInput = !tState.waitingForUserInput && (!pState.connected || !pState.waitingForInput);

    // 5. Evaluate Signal 5: No Unresolved Errors
    const noUnresolvedErrors = !tState.lastError && (!pState.connected || !pState.hasError);

    // 6. Evaluate Signal 6: Workspace Quiet (File settle & process check)
    const workspaceQuiet = sState.isWorkspaceQuiet && !sState.isProcessActive;

    this.state.signals = {
      transcriptDone,
      noActiveTools,
      playwrightIdle,
      notWaitingForInput,
      noUnresolvedErrors,
      workspaceQuiet
    };

    // Collect blocking reasons
    const reasons = [];
    if (!transcriptDone) reasons.push('AI agent is still executing prompt response');
    if (!noActiveTools) reasons.push('Tool calls are actively executing');
    if (!playwrightIdle) reasons.push('Browser UI shows active generation or busy indicator');
    if (!notWaitingForInput) reasons.push('Agent is waiting for user confirmation or input');
    if (!noUnresolvedErrors) reasons.push('Unresolved errors detected');
    if (!workspaceQuiet) reasons.push('Workspace file or background process activity not yet settled');

    this.state.reasonsBlocked = reasons;

    // Strict Rule: Are ALL signals simultaneously green?
    const allSignalsGreen = transcriptDone && noActiveTools && playwrightIdle && notWaitingForInput && noUnresolvedErrors && workspaceQuiet;

    if (!allSignalsGreen) {
      // Reset cooldown immediately if any signal drops!
      if (this.consecutiveStableSeconds > 0) {
        logger.warn('VerificationEngine', `Verification interrupted: ${reasons.join(', ')}. Resetting stabilization timer.`);
      }
      this.consecutiveStableSeconds = 0;
      this.state.cooldownElapsedSeconds = 0;
      this.state.verificationProgressPercent = 0;

      if (!notWaitingForInput) {
        this.state.overallStatus = 'WAITING_INPUT';
      } else if (!noUnresolvedErrors) {
        this.state.overallStatus = 'ERROR';
      } else {
        this.state.overallStatus = 'EXECUTING';
      }
    } else {
      // All signals are green
      const isActionArmed = Boolean(this.state.autoShutdownEnabled || this.state.autoSleepEnabled);

      if (!isActionArmed) {
        // Stabilization Timer starts ONLY when Auto-Shutdown or Auto-Sleep is enabled!
        this.consecutiveStableSeconds = 0;
        this.state.cooldownElapsedSeconds = 0;
        this.state.verificationProgressPercent = 0;
        this.state.overallStatus = 'STANDBY';
        this.state.reasonsBlocked = ['Prompt completed. Enable Auto-Shutdown or Auto-Sleep to begin stabilization timer.'];
      } else {
        // All signals green AND an action is enabled -> Increment continuous stable seconds
        this.consecutiveStableSeconds += 1;
        this.state.cooldownElapsedSeconds = this.consecutiveStableSeconds;
        const target = this.state.cooldownTargetSeconds;
        this.state.verificationProgressPercent = Math.min(100, Math.round((this.consecutiveStableSeconds / target) * 100));

        if (this.consecutiveStableSeconds < target) {
          this.state.overallStatus = 'VERIFYING';
          this.state.reasonsBlocked = [`Verifying completion stability (${this.consecutiveStableSeconds}/${target}s)`];
        } else {
          // Cooldown target reached! Task verified as fully completed!
          if (this.state.overallStatus !== 'SHUTDOWN_COUNTDOWN' && this.state.overallStatus !== 'SHUTDOWN_TRIGGERED' && this.state.overallStatus !== 'CONFIRMATION_PENDING') {
            logger.audit('VerificationEngine', 'Task completion FULLY VERIFIED across all multi-signals!');
            eventBus.emit('prompt:verified_completed', {
              prompt: this.state.currentPrompt,
              verificationDurationSeconds: this.consecutiveStableSeconds
            });

            if (this.state.manualConfirmationMode) {
              this.state.overallStatus = 'CONFIRMATION_PENDING';
              const act = this.state.autoSleepEnabled ? 'sleep' : 'shutdown';
              this.state.reasonsBlocked = [`Manual confirmation required before ${act}`];
            } else {
              this.state.overallStatus = 'COMPLETED';
              this.state.reasonsBlocked = [];
              eventBus.emit('shutdown:ready');
            }
          }
        }
      }
    }

    this.state.lastDecisionTimestamp = new Date().toISOString();
    this.emitState();
  }

  emergencyStop() {
    this.state.isEmergencyStopped = true;
    this.state.overallStatus = 'ABORTED';
    this.consecutiveStableSeconds = 0;
    this.state.cooldownElapsedSeconds = 0;
    this.state.verificationProgressPercent = 0;
    this.state.reasonsBlocked = ['EMERGENCY STOP TRIGGERED BY USER'];
    logger.safety('VerificationEngine', 'EMERGENCY STOP ACTIVATED! All shutdown processes canceled.');
    this.emitState();
  }

  confirmManualShutdown() {
    if (this.state.overallStatus === 'CONFIRMATION_PENDING') {
      logger.audit('VerificationEngine', 'User confirmed manual shutdown.');
      this.state.overallStatus = 'COMPLETED';
      this.state.reasonsBlocked = [];
      eventBus.emit('shutdown:ready');
      this.emitState();
    }
  }

  setVerificationDelay(seconds) {
    const sec = Math.max(5, Math.min(300, parseInt(seconds, 10) || 20));
    this.state.cooldownTargetSeconds = sec;
    this.saveSettings();
    logger.info('VerificationEngine', `Verification delay set to ${sec}s`);
    this.emitState();
  }

  toggleMonitoring(enabled) {
    // Supervisor monitoring is always active; controls govern shutdown behavior
    this.emitState();
  }

  toggleAutoShutdown(enabled) {
    this.state.autoShutdownEnabled = Boolean(enabled);
    if (this.state.autoShutdownEnabled) {
      this.state.autoSleepEnabled = false;
      this.state.targetAction = 'SHUTDOWN';
      this.state.isEmergencyStopped = false;
      this.consecutiveStableSeconds = 0;
      this.state.cooldownElapsedSeconds = 0;
      this.state.verificationProgressPercent = 0;
      logger.safety('VerificationEngine', 'Auto-Shutdown ARMED. Stabilization timer will start when all signals pass.');
    } else {
      if (!this.state.autoSleepEnabled) {
        this.state.targetAction = 'NONE';
        this.consecutiveStableSeconds = 0;
        this.state.cooldownElapsedSeconds = 0;
        this.state.verificationProgressPercent = 0;
      }
      logger.info('VerificationEngine', 'Auto-Shutdown disarmed.');
    }
    this.saveSettings();

    // If auto-shutdown was turned OFF during active countdown and sleep is not enabled, cancel countdown cleanly
    if (!this.state.autoShutdownEnabled && !this.state.autoSleepEnabled && this.state.overallStatus === 'SHUTDOWN_COUNTDOWN') {
      logger.info('VerificationEngine', 'Action turned OFF by user. Cancelling countdown.');
      this.state.overallStatus = 'STANDBY';
      this.state.reasonsBlocked = ['Action mode turned OFF. Computer will stay running.'];
      eventBus.emit('action:disabled');
    }

    this.emitState();
  }

  toggleAutoSleep(enabled) {
    if (enabled && this.state.hasTriggeredSleep) {
      logger.warn('VerificationEngine', 'Auto-Sleep 1-time limit reached for this session. Reload page (F5) to re-arm.');
      this.emitState();
      return;
    }
    this.state.autoSleepEnabled = Boolean(enabled);
    if (this.state.autoSleepEnabled) {
      this.state.autoShutdownEnabled = false;
      this.state.targetAction = 'SLEEP';
      this.state.isEmergencyStopped = false;
      this.consecutiveStableSeconds = 0;
      this.state.cooldownElapsedSeconds = 0;
      this.state.verificationProgressPercent = 0;
      logger.safety('VerificationEngine', 'Auto-Sleep ARMED. Stabilization timer will start when all signals pass.');
    } else {
      if (!this.state.autoShutdownEnabled) {
        this.state.targetAction = 'NONE';
        this.consecutiveStableSeconds = 0;
        this.state.cooldownElapsedSeconds = 0;
        this.state.verificationProgressPercent = 0;
      }
      logger.info('VerificationEngine', 'Auto-Sleep disarmed.');
    }
    this.saveSettings();

    // If auto-sleep was turned OFF during active countdown and shutdown is not enabled, cancel countdown cleanly
    if (!this.state.autoSleepEnabled && !this.state.autoShutdownEnabled && this.state.overallStatus === 'SHUTDOWN_COUNTDOWN') {
      logger.info('VerificationEngine', 'Action turned OFF by user. Cancelling countdown.');
      this.state.overallStatus = 'STANDBY';
      this.state.reasonsBlocked = ['Action mode turned OFF. Computer will stay running.'];
      eventBus.emit('action:disabled');
    }

    this.emitState();
  }

  toggleDryRun(enabled) {
    this.state.dryRunMode = Boolean(enabled);
    this.saveSettings();
    logger.info('VerificationEngine', `Dry-Run Mode is now ${this.state.dryRunMode ? 'ACTIVE (Safe Simulation)' : 'LIVE (Will Shutdown OS)'}`);
    this.emitState();
  }

  toggleManualConfirmation(enabled) {
    this.state.manualConfirmationMode = Boolean(enabled);
    this.saveSettings();
    logger.info('VerificationEngine', `Manual Confirmation Mode is now ${this.state.manualConfirmationMode ? 'ENABLED' : 'DISABLED'}`);
    this.emitState();
  }

  emitState() {
    eventBus.emit('engine:state', this.getState());
  }

  getState() {
    return { ...this.state };
  }

  stop() {
    if (this.ticker) clearInterval(this.ticker);
    if (this.executionTimeoutTimer) clearTimeout(this.executionTimeoutTimer);
    logger.info('VerificationEngine', 'Verification engine stopped.');
  }
}

module.exports = VerificationEngine;
