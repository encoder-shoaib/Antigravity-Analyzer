const { chromium } = require('playwright');
const config = require('../../config');
const logger = require('../utils/logger');
const eventBus = require('../utils/eventBus');

class PlaywrightObserver {
  constructor() {
    this.browser = null;
    this.context = null;
    this.activePage = null;
    this.monitoredPages = new Set();
    this.isConnected = false;
    this.pollInterval = null;
    this.reconnectTimeout = null;

    this.state = {
      connected: false,
      url: null,
      title: null,
      isGenerating: false,
      isBusy: false,
      waitingForInput: false,
      inputReady: false,
      hasError: false,
      errorText: null,
      domSignals: {
        stopButtonVisible: false,
        spinnerActive: false,
        inputEnabled: false,
        dialogWaiting: false
      },
      lastCheckedAt: null
    };
  }

  async start() {
    logger.info('PlaywrightObserver', `Initializing Playwright observer (CDP: ${config.PLAYWRIGHT.CDP_ENDPOINT})...`);
    // Connect asynchronously in background so dashboard and transcript watcher start instantly
    this.tryConnect().catch(() => {});

    // Start inspection polling loop
    this.pollInterval = setInterval(async () => {
      await this.inspectDOM();
    }, config.PLAYWRIGHT.POLL_INTERVAL_MS);

    return this;
  }

  async tryConnect() {
    try {
      if (this.browser && this.browser.isConnected()) {
        this.isConnected = true;
        this.state.connected = true;
        return true;
      }

      logger.info('PlaywrightObserver', `Attempting CDP connection to ${config.PLAYWRIGHT.CDP_ENDPOINT}...`);
      this.browser = await chromium.connectOverCDP(config.PLAYWRIGHT.CDP_ENDPOINT, {
        timeout: config.PLAYWRIGHT.CONNECT_TIMEOUT_MS
      });

      this.isConnected = true;
      this.state.connected = true;
      logger.success('PlaywrightObserver', `Successfully connected to Antigravity session over CDP!`);

      // Track contexts and pages
      const contexts = this.browser.contexts();
      if (contexts.length > 0) {
        this.context = contexts[0];
        const pages = this.context.pages();
        if (pages.length > 0) {
          this.activePage = pages[0];
          this.monitoredPages.add(this.activePage);
        }
      }

      this.browser.on('disconnected', () => {
        logger.warn('PlaywrightObserver', 'CDP browser connection closed.');
        this.isConnected = false;
        this.state.connected = false;
        this.scheduleReconnect();
      });

      eventBus.emit('browser:connected', { endpoint: config.PLAYWRIGHT.CDP_ENDPOINT });
      return true;
    } catch (err) {
      this.isConnected = false;
      this.state.connected = false;
      // Not an error - Antigravity may be running without remote debugging port or standalone
      logger.info('PlaywrightObserver', `CDP not available at ${config.PLAYWRIGHT.CDP_ENDPOINT}. Running in Multi-Signal Transcript & Process mode.`);
      this.scheduleReconnect();
      return false;
    }
  }

  scheduleReconnect() {
    if (this.reconnectTimeout) return;
    this.reconnectTimeout = setTimeout(async () => {
      this.reconnectTimeout = null;
      if (!this.isConnected) {
        await this.tryConnect();
      }
    }, 10000);
  }

  async inspectDOM() {
    this.state.lastCheckedAt = new Date().toISOString();

    if (!this.isConnected || !this.browser || !this.browser.isConnected()) {
      return;
    }

    try {
      // Find latest active page if current is null or closed
      if (!this.activePage || this.activePage.isClosed()) {
        const contexts = this.browser.contexts();
        for (const ctx of contexts) {
          const pages = ctx.pages();
          if (pages.length > 0) {
            this.activePage = pages[pages.length - 1];
            this.monitoredPages.add(this.activePage);
            break;
          }
        }
      }

      if (!this.activePage || this.activePage.isClosed()) {
        return;
      }

      const page = this.activePage;
      this.state.url = page.url();
      this.state.title = await page.title().catch(() => 'Antigravity');

      const selectors = config.PLAYWRIGHT.DOM_SELECTORS;

      // Evaluate UI state directly inside the page context
      const domSignals = await page.evaluate((sel) => {
        const isVisible = (selector) => {
          try {
            const el = document.querySelector(selector);
            if (!el) return false;
            const style = window.getComputedStyle(el);
            return style && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
          } catch (_) {
            return false;
          }
        };

        const stopBtn = isVisible(sel.STOP_BUTTON);
        const spinner = isVisible(sel.SPINNER);
        const waitingDialog = isVisible(sel.WAITING_INPUT_PROMPT);
        const hasErr = isVisible(sel.ERROR_BANNER);

        // Check if chat prompt input is present and enabled
        let inputEnabled = false;
        try {
          const inputEl = document.querySelector(sel.PROMPT_INPUT);
          if (inputEl) {
            inputEnabled = !inputEl.disabled && !inputEl.getAttribute('aria-disabled');
          }
        } catch (_) {}

        return {
          stopButtonVisible: stopBtn,
          spinnerActive: spinner,
          dialogWaiting: waitingDialog,
          hasError: hasErr,
          inputEnabled
        };
      }, selectors).catch(() => null);

      if (domSignals) {
        this.state.domSignals = domSignals;
        this.state.isGenerating = domSignals.stopButtonVisible;
        this.state.isBusy = domSignals.spinnerActive || domSignals.stopButtonVisible;
        this.state.waitingForInput = domSignals.dialogWaiting;
        this.state.inputReady = domSignals.inputEnabled && !domSignals.stopButtonVisible;
        this.state.hasError = domSignals.hasError;

        eventBus.emit('browser:dom_state', this.state);
      }
    } catch (err) {
      // Ignore evaluation errors caused by navigation or frame reload
    }
  }

  // Gracefully close all tabs and browser contexts managed by the automation before shutdown
  async closeAllBrowsers() {
    logger.audit('PlaywrightObserver', 'Initiating clean browser teardown before shutdown...');
    try {
      for (const page of this.monitoredPages) {
        if (!page.isClosed()) {
          try {
            logger.info('PlaywrightObserver', `Closing monitored tab: ${page.url()}`);
            await page.close();
          } catch (_) {}
        }
      }
      this.monitoredPages.clear();

      if (this.browser && this.browser.isConnected()) {
        logger.info('PlaywrightObserver', 'Disconnecting browser CDP session...');
        await this.browser.close().catch(() => {});
      }
      this.isConnected = false;
      this.state.connected = false;
      logger.success('PlaywrightObserver', 'All browser tabs and sessions safely closed.');
      return true;
    } catch (err) {
      logger.error('PlaywrightObserver', `Error during browser teardown: ${err.message}`);
      return false;
    }
  }

  stop() {
    if (this.pollInterval) clearInterval(this.pollInterval);
    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
    logger.info('PlaywrightObserver', 'Playwright observer stopped.');
  }

  getState() {
    return { ...this.state };
  }
}

module.exports = PlaywrightObserver;
