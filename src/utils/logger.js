const fs = require('fs');
const path = require('path');
const config = require('../../config');
const eventBus = require('./eventBus');

// Ensure logs directory exists
if (!fs.existsSync(config.LOGS_DIR)) {
  fs.mkdirSync(config.LOGS_DIR, { recursive: true });
}

const recentLogs = [];
const MAX_RECENT_LOGS = 200;

function loadInitialLogs() {
  try {
    if (fs.existsSync(config.SYSTEM_LOG_FILE)) {
      const content = fs.readFileSync(config.SYSTEM_LOG_FILE, 'utf8');
      const lines = content.trim().split('\n').filter(Boolean).slice(-60);
      for (const line of lines) {
        const match = line.match(/^\[(.*?)\]\s+\[(.*?)\]\s+\[(.*?)\]\s+(.*)$/);
        if (match) {
          recentLogs.push({
            timestamp: match[1],
            level: match[2],
            category: match[3],
            message: match[4]
          });
        }
      }
    }
  } catch (_) {}
}

loadInitialLogs();

function formatTimestamp() {
  return new Date().toISOString();
}

function writeLog(level, category, message, data = null) {
  const entry = {
    timestamp: formatTimestamp(),
    level,
    category,
    message,
    data: data ? (typeof data === 'object' ? data : { raw: data }) : undefined
  };

  const line = `[${entry.timestamp}] [${level}] [${category}] ${message}${data ? ' ' + JSON.stringify(data) : ''}\n`;

  // Write to console
  const color = {
    INFO: '\x1b[36m',
    SUCCESS: '\x1b[32m',
    WARN: '\x1b[33m',
    ERROR: '\x1b[31m',
    SAFETY: '\x1b[35m',
    AUDIT: '\x1b[34m'
  }[level] || '\x1b[0m';
  console.log(`${color}[${level}]\x1b[0m [${category}] ${message}`);

  // Append to system log file
  try {
    fs.appendFileSync(config.SYSTEM_LOG_FILE, line, 'utf8');
  } catch (err) {
    console.error('Failed to write log file:', err.message);
  }

  // Circular in-memory buffer
  recentLogs.push(entry);
  if (recentLogs.length > MAX_RECENT_LOGS) {
    recentLogs.shift();
  }

  // If AUDIT or SAFETY, append to audit.jsonl
  if (level === 'AUDIT' || level === 'SAFETY') {
    try {
      fs.appendFileSync(config.AUDIT_LOG_FILE, JSON.stringify(entry) + '\n', 'utf8');
    } catch (err) {
      console.error('Failed to write audit log:', err.message);
    }
  }

  // Emit to dashboard subscribers
  eventBus.emit('log:entry', entry);
}

const logger = {
  info: (cat, msg, data) => writeLog('INFO', cat, msg, data),
  success: (cat, msg, data) => writeLog('SUCCESS', cat, msg, data),
  warn: (cat, msg, data) => writeLog('WARN', cat, msg, data),
  error: (cat, msg, data) => writeLog('ERROR', cat, msg, data),
  safety: (cat, msg, data) => writeLog('SAFETY', cat, msg, data),
  audit: (cat, msg, data) => writeLog('AUDIT', cat, msg, data),
  getRecentLogs: () => [...recentLogs]
};

module.exports = logger;
