const path = require('path');
const os = require('os');

const USER_HOME = os.homedir();

module.exports = {
  // Web Server Port for the Dashboard
  PORT: process.env.PORT || 4321,

  // Antigravity Directories
  ANTIGRAVITY_DIR: process.env.ANTIGRAVITY_DIR || path.join(USER_HOME, '.gemini', 'antigravity'),
  get BRAIN_DIR() {
    return path.join(this.ANTIGRAVITY_DIR, 'brain');
  },
  WORKSPACE_DIR: process.env.WORKSPACE_DIR || process.cwd(),

  // Playwright & Browser Settings
  PLAYWRIGHT: {
    CDP_ENDPOINT: process.env.CDP_ENDPOINT || 'http://127.0.0.1:9222',
    HEADLESS: process.env.PLAYWRIGHT_HEADLESS !== 'false',
    CONNECT_TIMEOUT_MS: 5000,
    POLL_INTERVAL_MS: 1000,
    DOM_SELECTORS: {
      PROMPT_INPUT: 'textarea, [contenteditable="true"], .monaco-editor, input[type="text"]',
      STOP_BUTTON: 'button[aria-label*="Stop" i], button:has-text("Stop"), [data-testid="stop-button"], .codicon-stop',
      SPINNER: '.spinner, .loading, .streaming, [aria-busy="true"], .progress-bar',
      WAITING_INPUT_PROMPT: 'button:has-text("Approve"), button:has-text("Allow"), button:has-text("Confirm"), button:has-text("Proceed"), [data-testid="permission-dialog"]',
      ERROR_BANNER: '.error-badge, .error-banner, [role="alert"].error, .toast-error',
      COMPLETION_BADGE: '.task-done, .completion-badge, [data-state="completed"]'
    }
  },

  // Safety & Verification Timing
  SAFETY: {
    // Cooldown duration in seconds: all signals must remain 100% completed continuously
    VERIFICATION_DELAY_SECONDS: parseInt(process.env.VERIFICATION_DELAY_SECONDS || '20', 10),
    // Final countdown in seconds with emergency cancel capability before OS shutdown
    SHUTDOWN_GRACE_PERIOD_SECONDS: parseInt(process.env.SHUTDOWN_GRACE_PERIOD_SECONDS || '60', 10),
    // Auto Shutdown toggle (default false, can be toggled in UI)
    AUTO_SHUTDOWN_ENABLED: process.env.AUTO_SHUTDOWN_ENABLED === 'true', // Controlled by UI toggle
    // DRY RUN MODE: If true, will simulate shutdown/sleep without actually turning off/sleeping PC
    DRY_RUN_MODE: process.env.DRY_RUN_MODE === 'true', // Controlled by UI toggle (default false for live execution)
    // Manual confirmation required before initiating shutdown countdown
    MANUAL_CONFIRMATION_MODE: process.env.MANUAL_CONFIRMATION_MODE === 'true', // Controlled by UI toggle
    // Maximum prompt execution timeout in minutes (alert if exceeded)
    MAX_EXECUTION_TIMEOUT_MINUTES: parseInt(process.env.MAX_EXECUTION_TIMEOUT_MINUTES || '180', 10),
    // Process activity check: check for running child processes (powershell, node, python, etc.)
    CHECK_PROCESS_ACTIVITY: true,
    // File quiet duration in seconds: no workspace files modified in last N seconds
    FILE_SETTLE_SECONDS: 5
  },

  // Logging & Persistence
  LOGS_DIR: path.join(__dirname, 'logs'),
  AUDIT_LOG_FILE: path.join(__dirname, 'logs', 'audit.jsonl'),
  SYSTEM_LOG_FILE: path.join(__dirname, 'logs', 'monitor.log')
};
