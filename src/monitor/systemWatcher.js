const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const config = require('../../config');
const logger = require('../utils/logger');
const eventBus = require('../utils/eventBus');

class SystemWatcher {
  constructor() {
    this.workspaceDir = config.WORKSPACE_DIR;
    this.pollInterval = null;
    this.lastFileModificationTime = Date.now();
    this.activeProcesses = [];

    this.state = {
      isProcessActive: false,
      activeProcessCount: 0,
      activeProcessList: [],
      lastFileActivityAgoSeconds: 0,
      isWorkspaceQuiet: true,
      lastCheckedAt: null
    };
  }

  start() {
    logger.info('SystemWatcher', `Starting system & activity watcher on workspace: ${this.workspaceDir}`);

    this.pollInterval = setInterval(async () => {
      await this.checkSystemActivity();
    }, 1500);

    return this;
  }

  async checkSystemActivity() {
    this.state.lastCheckedAt = new Date().toISOString();

    // 1. Check workspace recent file modifications
    this.checkWorkspaceFileActivity();

    // 2. Check child/tool process activity
    if (config.SAFETY.CHECK_PROCESS_ACTIVITY) {
      await this.checkProcessActivity();
    }

    eventBus.emit('system:activity', this.state);
  }

  checkWorkspaceFileActivity() {
    try {
      const now = Date.now();
      let newestMtime = 0;

      const scanDir = (dir, depth = 0) => {
        if (depth > 3) return;
        if (!fs.existsSync(dir)) return;

        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'logs') continue;
          const fullPath = path.join(dir, entry.name);
          try {
            const stat = fs.statSync(fullPath);
            if (stat.mtimeMs > newestMtime) {
              newestMtime = stat.mtimeMs;
            }
            if (entry.isDirectory()) {
              scanDir(fullPath, depth + 1);
            }
          } catch (_) {}
        }
      };

      scanDir(this.workspaceDir);

      if (newestMtime > this.lastFileModificationTime) {
        this.lastFileModificationTime = newestMtime;
      }

      const diffSeconds = Math.floor((now - this.lastFileModificationTime) / 1000);
      this.state.lastFileActivityAgoSeconds = diffSeconds;
      this.state.isWorkspaceQuiet = diffSeconds >= config.SAFETY.FILE_SETTLE_SECONDS;
    } catch (err) {
      // In case of read permission or scan issue
      this.state.isWorkspaceQuiet = true;
    }
  }

  checkProcessActivity() {
    return new Promise((resolve) => {
      // Only flag heavy compiler / build runners that might be executing in background
      // (Do NOT block on ambient cmd.exe or pwsh.exe which are always present in VS Code / Windows)
      const cmd = 'tasklist /FO CSV /NH';
      exec(cmd, { windowsHide: true }, (err, stdout) => {
        if (err || !stdout) {
          this.state.isProcessActive = false;
          return resolve();
        }

        const lines = stdout.split('\r\n');
        const heavyBuildProcesses = ['gcc.exe', 'clang.exe', 'rustc.exe', 'cargo.exe', 'mvn.exe', 'gradle.exe', 'pytest.exe'];
        const matched = [];

        for (const line of lines) {
          const parts = line.split('","');
          if (parts.length > 0) {
            const procName = parts[0].replace(/"/g, '').toLowerCase();
            for (const susp of heavyBuildProcesses) {
              if (procName === susp) {
                matched.push(procName);
              }
            }
          }
        }

        this.state.activeProcessCount = matched.length;
        this.state.activeProcessList = matched;
        this.state.isProcessActive = matched.length > 0;

        resolve();
      });
    });
  }

  stop() {
    if (this.pollInterval) clearInterval(this.pollInterval);
    logger.info('SystemWatcher', 'System watcher stopped.');
  }

  getState() {
    return { ...this.state };
  }
}

module.exports = SystemWatcher;
