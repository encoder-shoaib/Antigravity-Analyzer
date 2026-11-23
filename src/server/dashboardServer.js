const express = require('express');
const path = require('path');
const config = require('../../config');
const logger = require('../utils/logger');
const eventBus = require('../utils/eventBus');

class DashboardServer {
  constructor(verificationEngine, shutdownController, playwrightObserver, transcriptWatcher, systemWatcher) {
    this.verificationEngine = verificationEngine;
    this.shutdownController = shutdownController;
    this.playwrightObserver = playwrightObserver;
    this.transcriptWatcher = transcriptWatcher;
    this.systemWatcher = systemWatcher;

    this.app = express();
    this.server = null;
    this.sseClients = new Set();

    this.setupRoutes();
    this.bindEvents();
  }

  setupRoutes() {
    this.app.use(express.json());

    // Reset 1-time sleep lock when user reloads the dashboard page
    this.app.get(['/', '/index.html'], (req, res, next) => {
      if (this.verificationEngine) {
        this.verificationEngine.state.hasTriggeredSleep = false;
      }
      next();
    });

    // Reset sleep lock API (called by client on page init)
    this.app.post('/api/reset-sleep-lock', (req, res) => {
      if (this.verificationEngine) {
        this.verificationEngine.state.hasTriggeredSleep = false;
        this.broadcastUpdate();
      }
      res.json({ success: true, hasTriggeredSleep: false });
    });

    this.app.use(express.static(path.join(__dirname, '..', '..', 'public')));

    // SSE Stream for real-time dashboard updates
    this.app.get('/api/events', (req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      // Send initial snapshot
      res.write(`data: ${JSON.stringify(this.getFullSnapshot())}\n\n`);

      this.sseClients.add(res);

      req.on('close', () => {
        this.sseClients.delete(res);
      });
    });

    // REST Snapshot
    this.app.get('/api/status', (req, res) => {
      res.json(this.getFullSnapshot());
    });

    // Emergency Stop
    this.app.post('/api/emergency-stop', (req, res) => {
      logger.safety('DashboardServer', 'Emergency Stop triggered via Dashboard API!');
      this.verificationEngine.emergencyStop();
      this.shutdownController.abortShutdown('Emergency Stop via Dashboard');
      this.broadcastUpdate();
      res.json({ success: true, message: 'Emergency Stop Activated' });
    });

    // Toggle Monitoring Active
    this.app.post('/api/toggle-monitoring', (req, res) => {
      const { enabled } = req.body;
      this.verificationEngine.toggleMonitoring(enabled);
      this.broadcastUpdate();
      res.json({ success: true, isMonitoringActive: this.verificationEngine.state.isMonitoringActive });
    });

    // Toggle Auto-Shutdown
    this.app.post('/api/toggle-auto-shutdown', (req, res) => {
      const { enabled } = req.body;
      this.verificationEngine.toggleAutoShutdown(enabled);
      this.broadcastUpdate();
      res.json({
        success: true,
        autoShutdown: this.verificationEngine.state.autoShutdownEnabled,
        autoSleep: this.verificationEngine.state.autoSleepEnabled,
        targetAction: this.verificationEngine.state.targetAction
      });
    });

    // Toggle Auto-Sleep
    this.app.post('/api/toggle-auto-sleep', (req, res) => {
      const { enabled } = req.body;
      if (enabled && this.verificationEngine && this.verificationEngine.state.hasTriggeredSleep) {
        return res.status(400).json({
          success: false,
          error: 'Auto-Sleep 1-time limit reached for this session. Reload page (F5) to re-arm.',
          hasTriggeredSleep: true
        });
      }
      this.verificationEngine.toggleAutoSleep(enabled);
      this.broadcastUpdate();
      res.json({
        success: true,
        autoShutdown: this.verificationEngine.state.autoShutdownEnabled,
        autoSleep: this.verificationEngine.state.autoSleepEnabled,
        targetAction: this.verificationEngine.state.targetAction
      });
    });

    // Toggle Dry Run Mode
    this.app.post('/api/toggle-dry-run', (req, res) => {
      const { enabled } = req.body;
      this.verificationEngine.toggleDryRun(enabled);
      this.broadcastUpdate();
      res.json({ success: true, dryRun: this.verificationEngine.state.dryRunMode });
    });

    // Toggle Manual Confirmation Mode
    this.app.post('/api/toggle-manual-confirm', (req, res) => {
      const { enabled } = req.body;
      this.verificationEngine.toggleManualConfirmation(enabled);
      this.broadcastUpdate();
      res.json({ success: true, manualConfirmation: this.verificationEngine.state.manualConfirmationMode });
    });

    // Confirm Manual Shutdown
    this.app.post('/api/confirm-shutdown', (req, res) => {
      this.verificationEngine.confirmManualShutdown();
      this.broadcastUpdate();
      res.json({ success: true, message: 'Manual shutdown confirmed' });
    });

    // Abort Shutdown
    this.app.post('/api/abort-shutdown', (req, res) => {
      this.shutdownController.abortShutdown('Aborted by user via dashboard');
      if (this.verificationEngine) {
        this.verificationEngine.state.autoShutdownEnabled = false;
        this.verificationEngine.state.autoSleepEnabled = false;
        this.verificationEngine.state.targetAction = 'NONE';
        this.verificationEngine.state.overallStatus = 'ABORTED';
        this.verificationEngine.saveSettings();
      }
      this.broadcastUpdate();
      res.json({ success: true, message: 'Shutdown aborted' });
    });

    // Set Verification Delay
    this.app.post('/api/set-verification-delay', (req, res) => {
      const { seconds } = req.body;
      this.verificationEngine.setVerificationDelay(seconds);
      this.broadcastUpdate();
      res.json({ success: true, delaySeconds: this.verificationEngine.state.cooldownTargetSeconds });
    });

    // Simulate Prompt (for interactive test / verification)
    this.app.post('/api/simulate-prompt', (req, res) => {
      const { prompt, hasError, waitForInput, durationSeconds } = req.body;
      const promptText = prompt || 'Test AI Task: Generate reports and perform automated checks';

      logger.info('DashboardServer', `Simulating prompt execution: "${promptText}"`);
      eventBus.emit('prompt:detected', {
        prompt: promptText,
        timestamp: new Date().toISOString(),
        conversationId: 'simulated-session-' + Date.now()
      });

      if (this.transcriptWatcher) {
        this.transcriptWatcher.state.currentPrompt = promptText;
        this.transcriptWatcher.state.status = 'RUNNING';
        this.transcriptWatcher.state.isTurnComplete = false;
        this.transcriptWatcher.state.waitingForUserInput = false;
        this.transcriptWatcher.state.lastError = null;
        this.transcriptWatcher.state.activeToolCalls = [{
          name: 'run_command',
          args: { CommandLine: 'npm test -- --coverage' },
          startedAt: new Date().toISOString()
        }];
      }

      const duration = (durationSeconds || 4) * 1000;

      setTimeout(() => {
        if (hasError) {
          if (this.transcriptWatcher) {
            this.transcriptWatcher.state.lastError = 'Simulated build error: exit code 1';
            this.transcriptWatcher.state.status = 'ERROR';
          }
          eventBus.emit('error:detected', { error: 'Simulated build error: exit code 1' });
        } else if (waitForInput) {
          if (this.transcriptWatcher) {
            this.transcriptWatcher.state.waitingForUserInput = true;
            this.transcriptWatcher.state.status = 'WAITING_INPUT';
          }
          eventBus.emit('agent:waiting_input', { reason: 'Approval required for database migration' });
        } else {
          if (this.transcriptWatcher) {
            this.transcriptWatcher.state.activeToolCalls = [];
            this.transcriptWatcher.state.isTurnComplete = true;
            this.transcriptWatcher.state.status = 'COMPLETED';
          }
          eventBus.emit('turn:completed', { timestamp: new Date().toISOString() });
        }
        this.broadcastUpdate();
      }, duration);

      this.broadcastUpdate();
      res.json({ success: true, message: 'Simulation started' });
    });
  }

  bindEvents() {
    // Forward engine updates to SSE clients
    eventBus.on('engine:state', () => this.broadcastUpdate());
    eventBus.on('shutdown:tick', () => this.broadcastUpdate());
    eventBus.on('log:entry', () => this.broadcastUpdate());
  }

  broadcastUpdate() {
    if (this.sseClients.size === 0) return;
    const payload = `data: ${JSON.stringify(this.getFullSnapshot())}\n\n`;
    for (const client of this.sseClients) {
      try {
        client.write(payload);
      } catch (_) {
        this.sseClients.delete(client);
      }
    }
  }

  getFullSnapshot() {
    return {
      timestamp: new Date().toISOString(),
      engine: this.verificationEngine ? this.verificationEngine.getState() : {},
      countdown: this.shutdownController ? this.shutdownController.getCountdown() : {},
      playwright: this.playwrightObserver ? this.playwrightObserver.getState() : {},
      transcript: this.transcriptWatcher ? this.transcriptWatcher.getState() : {},
      system: this.systemWatcher ? this.systemWatcher.getState() : {},
      recentLogs: logger.getRecentLogs()
    };
  }

  start() {
    return new Promise((resolve) => {
      this.server = this.app.listen(config.PORT, () => {
        logger.success('DashboardServer', `AI Task Completion & Auto-Shutdown Dashboard live at: http://localhost:${config.PORT}`);
        resolve();
      });
    });
  }

  stop() {
    if (this.server) {
      this.server.close();
      logger.info('DashboardServer', 'Dashboard server closed.');
    }
  }
}

module.exports = DashboardServer;
