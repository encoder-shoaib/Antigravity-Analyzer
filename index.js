const config = require('./config');
const logger = require('./src/utils/logger');
const TranscriptWatcher = require('./src/monitor/transcriptWatcher');
const PlaywrightObserver = require('./src/monitor/playwrightObserver');
const SystemWatcher = require('./src/monitor/systemWatcher');
const VerificationEngine = require('./src/engine/verificationEngine');
const ShutdownController = require('./src/shutdown/shutdownController');
const DashboardServer = require('./src/server/dashboardServer');

async function main() {
  console.log('\n=============================================================');
  console.log('   Google Antigravity AI Task Completion & Auto-Shutdown');
  console.log('                 Safe Guarded Supervisor');
  console.log('=============================================================\n');

  logger.info('System', 'Starting Antigravity Task Monitor and Auto-Shutdown Supervisor...');
  logger.info('System', `Workspace Directory: ${config.WORKSPACE_DIR}`);
  logger.info('System', `Antigravity App Data: ${config.ANTIGRAVITY_DIR}`);
  logger.safety('System', `Auto-Shutdown: ${config.SAFETY.AUTO_SHUTDOWN_ENABLED ? 'ENABLED' : 'DISABLED'}`);
  logger.safety('System', `Safety Mode: ${config.SAFETY.DRY_RUN_MODE ? 'DRY-RUN (Safe Simulation - PC will not power down)' : 'LIVE (Will shutdown OS)'}`);
  logger.safety('System', `Stabilization Cooldown Delay: ${config.SAFETY.VERIFICATION_DELAY_SECONDS}s`);
  logger.safety('System', `Shutdown Grace Period: ${config.SAFETY.SHUTDOWN_GRACE_PERIOD_SECONDS}s`);

  // 1. Initialize Subsystem Monitors
  const transcriptWatcher = new TranscriptWatcher();
  const playwrightObserver = new PlaywrightObserver();
  const systemWatcher = new SystemWatcher();

  // 2. Initialize Safety Verification Engine
  const verificationEngine = new VerificationEngine(transcriptWatcher, playwrightObserver, systemWatcher);

  // 3. Initialize Shutdown Controller
  const shutdownController = new ShutdownController(verificationEngine, playwrightObserver);

  // 4. Initialize Web Dashboard Server
  const dashboardServer = new DashboardServer(
    verificationEngine,
    shutdownController,
    playwrightObserver,
    transcriptWatcher,
    systemWatcher
  );

  // Start All Services
  transcriptWatcher.start();
  await playwrightObserver.start();
  systemWatcher.start();
  verificationEngine.start();
  await dashboardServer.start();

  logger.success('System', `System fully initialized! Open dashboard at: http://localhost:${config.PORT}`);

  // Graceful Process Termination
  const cleanup = async () => {
    logger.info('System', 'Shutting down monitor supervisor...');
    transcriptWatcher.stop();
    playwrightObserver.stop();
    systemWatcher.stop();
    verificationEngine.stop();
    dashboardServer.stop();
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

if (require.main === module) {
  main().catch((err) => {
    logger.error('System', `Fatal initialization error: ${err.message}`, { stack: err.stack });
    process.exit(1);
  });
}

module.exports = { main };
