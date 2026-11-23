// Antigravity Pro Supervisor Dashboard Client
let audioCtx = null;
let isTerminalCleared = false;

function playAudioBeep(freq = 440, duration = 0.15) {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.08, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + duration);
  } catch (_) {}
}

const UI = {
  // Navigation & Connection
  connIndicator: document.getElementById('connIndicator'),
  connLabel: document.getElementById('connLabel'),
  btnEmergencyStop: document.getElementById('btnEmergencyStop'),

  // Metric Tiles
  tileStatusIcon: document.getElementById('tileStatusIcon'),
  tileStatusText: document.getElementById('tileStatusText'),
  tileStatusSub: document.getElementById('tileStatusSub'),
  tileCooldownVal: document.getElementById('tileCooldownVal'),
  tileProgressBar: document.getElementById('tileProgressBar'),
  tileCooldownDesc: document.getElementById('tileCooldownDesc'),
  tileCooldownPct: document.getElementById('tileCooldownPct'),
  tileGateIcon: document.getElementById('tileGateIcon'),
  tileGatesScore: document.getElementById('tileGatesScore'),
  tileModeIcon: document.getElementById('tileModeIcon'),
  tileModeTitle: document.getElementById('tileModeTitle'),
  tileModeSub: document.getElementById('tileModeSub'),

  // Countdown Alert
  shutdownCountdownCard: document.getElementById('shutdownCountdownCard'),
  countdownNumber: document.getElementById('countdownNumber'),
  countdownDescription: document.getElementById('countdownDescription'),
  btnAbortCountdown: document.getElementById('btnAbortCountdown'),

  // Prompt Card
  promptStepNum: document.getElementById('promptStepNum'),
  promptTimeText: document.getElementById('promptTimeText'),
  promptBodyText: document.getElementById('promptBodyText'),
  promptConvId: document.getElementById('promptConvId'),
  promptActiveToolsCount: document.getElementById('promptActiveToolsCount'),

  // 6 Gates Matrix
  matrixPassedBadge: document.getElementById('matrixPassedBadge'),

  // Controls
  toggleAutoShutdown: document.getElementById('toggleAutoShutdown'),
  toggleAutoSleep: document.getElementById('toggleAutoSleep'),
  toggleAutoSleepSub: document.getElementById('toggleAutoSleepSub'),
  toggleDryRun: document.getElementById('toggleDryRun'),
  toggleManualConfirm: document.getElementById('toggleManualConfirm'),
  inputDelaySeconds: document.getElementById('inputDelaySeconds'),
  btnSaveDelay: document.getElementById('btnSaveDelay'),

  // Terminal
  terminalScreen: document.getElementById('terminalScreen'),
  termEventsCount: document.getElementById('termEventsCount'),
  chkAutoScroll: document.getElementById('chkAutoScroll'),
  btnClearTerminal: document.getElementById('btnClearTerminal'),
  termSessionId: document.getElementById('termSessionId')
};

// Start real-time connection (SSE + HTTP Polling fallback)
async function fetchStatus() {
  try {
    const res = await fetch('/api/status');
    if (res.ok) {
      setOnlineState(true);
      const data = await res.json();
      renderSnapshot(data);
    } else {
      setOnlineState(false);
    }
  } catch (_) {
    setOnlineState(false);
  }
}

function initDashboard() {
  // Clear any previous session sleep lock on fresh page load/reload
  fetch('/api/reset-sleep-lock', { method: 'POST' }).catch(() => {});

  let sse = null;
  try {
    sse = new EventSource('/api/events');
    sse.onopen = () => setOnlineState(true);
    sse.onmessage = (e) => {
      setOnlineState(true);
      try {
        renderSnapshot(JSON.parse(e.data));
      } catch (_) {}
    };
    sse.onerror = () => setOnlineState(false);
  } catch (_) {
    setOnlineState(false);
  }

  // Immediate fetch on startup
  fetchStatus();

  // Fallback poll every 1.5s
  setInterval(fetchStatus, 1500);
}

function setOnlineState(online) {
  if (online) {
    UI.connIndicator.className = 'h-2 w-2 rounded-full bg-emerald-500 animate-pulse';
    UI.connLabel.textContent = 'Connected';
    UI.connLabel.className = 'text-slate-500 font-medium';
  } else {
    UI.connIndicator.className = 'h-2 w-2 rounded-full bg-rose-500';
    UI.connLabel.textContent = 'Offline (Run npm start)';
    UI.connLabel.className = 'text-rose-500 font-semibold';
  }
}

function renderSnapshot(data) {
  const engine = data.engine || {};
  const countdown = data.countdown || {};
  const transcript = data.transcript || {};
  const playwright = data.playwright || {};
  const system = data.system || {};
  const logs = data.recentLogs || [];

  const status = engine.overallStatus || 'IDLE';

  // 1. Metric Tile 1: Status
  updateStatusTile(status, engine);

  // 2. Metric Tile 2: Stabilization Cooldown Progress
  const elapsed = engine.cooldownElapsedSeconds || 0;
  const target = engine.cooldownTargetSeconds || 20;
  const percent = engine.verificationProgressPercent || 0;
  UI.tileCooldownVal.textContent = `${elapsed}s / ${target}s`;
  UI.tileProgressBar.style.width = `${percent}%`;
  UI.tileCooldownPct.textContent = `${percent}%`;

  if (status === 'EXECUTING') {
    UI.tileCooldownDesc.textContent = 'AI working (locked)';
  } else if (status === 'VERIFYING') {
    UI.tileCooldownDesc.textContent = 'Stabilizing...';
  } else if (status === 'COMPLETED') {
    UI.tileCooldownDesc.textContent = 'Verified complete';
  } else {
    UI.tileCooldownDesc.textContent = 'Standby';
  }

  // 3. Metric Tile 3 & 6-Gate Matrix: Safety Score
  renderSafetyGates(engine.signals || {}, transcript, playwright, system);

  // 4. Metric Tile 4: Action Mode (Auto-Shutdown vs Auto-Sleep)
  const targetAction = engine.targetAction || (engine.autoSleepEnabled ? 'SLEEP' : (engine.autoShutdownEnabled ? 'SHUTDOWN' : 'NONE'));
  if (targetAction === 'NONE') {
    UI.tileModeTitle.textContent = 'STANDBY (Action OFF)';
    UI.tileModeTitle.className = 'text-base font-bold text-slate-500 mt-0.5';
    UI.tileModeSub.textContent = 'Enable Auto-Shutdown or Auto-Sleep';
    UI.tileModeIcon.className = 'h-11 w-11 rounded-xl bg-slate-100 text-slate-400 flex items-center justify-center shrink-0';
    UI.tileModeIcon.innerHTML = `<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"/></svg>`;
  } else if (targetAction === 'SLEEP') {
    if (engine.dryRunMode) {
      UI.tileModeTitle.textContent = 'Auto-Sleep (Dry-Run)';
      UI.tileModeTitle.className = 'text-base font-bold text-indigo-700 mt-0.5';
      UI.tileModeSub.textContent = 'Safe test simulation of PC Sleep';
      UI.tileModeIcon.className = 'h-11 w-11 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center shrink-0';
    } else {
      UI.tileModeTitle.textContent = 'ARMED: Auto-Sleep';
      UI.tileModeTitle.className = 'text-base font-bold text-indigo-700 mt-0.5';
      UI.tileModeSub.textContent = 'Preserves all tabs & puts PC to sleep';
      UI.tileModeIcon.className = 'h-11 w-11 rounded-xl bg-indigo-100 text-indigo-700 flex items-center justify-center shrink-0';
    }
    UI.tileModeIcon.innerHTML = `<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"/></svg>`;
  } else {
    // SHUTDOWN
    if (engine.dryRunMode) {
      UI.tileModeTitle.textContent = 'Auto-Shutdown (Dry-Run)';
      UI.tileModeTitle.className = 'text-base font-bold text-emerald-700 mt-0.5';
      UI.tileModeSub.textContent = 'Safe simulation of PC Shutdown';
      UI.tileModeIcon.className = 'h-11 w-11 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center shrink-0';
    } else {
      UI.tileModeTitle.textContent = 'ARMED: Auto-Shutdown';
      UI.tileModeTitle.className = 'text-base font-bold text-rose-700 mt-0.5';
      UI.tileModeSub.textContent = 'Will close all tabs & shut down PC';
      UI.tileModeIcon.className = 'h-11 w-11 rounded-xl bg-rose-100 text-rose-700 flex items-center justify-center shrink-0';
    }
    UI.tileModeIcon.innerHTML = `<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>`;
  }

  // 5. Action Countdown Card & Emergency Stop action
  if (countdown.isCountdownActive) {
    UI.shutdownCountdownCard.classList.remove('hidden');
    UI.countdownNumber.textContent = countdown.secondsRemaining || 60;
    const act = targetAction === 'SLEEP' ? 'SLEEP' : 'SHUTDOWN';
    const actText = targetAction === 'SLEEP' ? 'enter Sleep mode' : 'shut down';
    if (engine.dryRunMode) {
      UI.countdownDescription.textContent = `[DRY-RUN SIMULATION] Computer will simulate ${act} in ${countdown.secondsRemaining} seconds (Safe test - PC will not turn off/sleep). Click Stop Countdown or Emergency Stop to cancel.`;
    } else if (targetAction === 'SLEEP') {
      UI.countdownDescription.textContent = `[LIVE PC SLEEP] Computer will enter Sleep mode in ${countdown.secondsRemaining} seconds! All open tabs and apps will stay open. Click Stop Countdown or Emergency Stop to cancel.`;
    } else {
      UI.countdownDescription.textContent = `[LIVE PC SHUTDOWN] Computer will shut down in ${countdown.secondsRemaining} seconds! All browser tabs will be closed automatically. Click Stop Countdown or Emergency Stop to cancel.`;
    }
    playAudioBeep(440, 0.1);
  } else {
    UI.shutdownCountdownCard.classList.add('hidden');
  }

  // 6. Active Prompt Card
  if (engine.currentPrompt) {
    UI.promptBodyText.textContent = engine.currentPrompt;
  } else {
    UI.promptBodyText.textContent = 'Waiting for prompt from Google Antigravity...';
  }
  UI.promptStepNum.textContent = transcript.stepIndex || 0;
  if (transcript.promptTimestamp) {
    UI.promptTimeText.textContent = new Date(transcript.promptTimestamp).toLocaleTimeString();
  }
  UI.promptConvId.textContent = transcript.conversationId || 'None';

  const activeCount = transcript.activeToolCalls ? transcript.activeToolCalls.length : 0;
  UI.promptActiveToolsCount.textContent = `${activeCount} Active Tools`;
  if (activeCount > 0) {
    UI.promptActiveToolsCount.className = 'font-semibold text-blue-600 animate-pulse';
  } else {
    UI.promptActiveToolsCount.className = 'font-semibold text-slate-500';
  }

  // 7. Controls Toggles
  UI.toggleAutoShutdown.checked = Boolean(engine.autoShutdownEnabled);
  if (UI.toggleAutoSleep) {
    UI.toggleAutoSleep.checked = Boolean(engine.autoSleepEnabled);
    if (engine.hasTriggeredSleep) {
      UI.toggleAutoSleep.disabled = true;
      if (UI.toggleAutoSleepSub) {
        UI.toggleAutoSleepSub.textContent = 'Triggered (1-time). Reload page to arm again.';
        UI.toggleAutoSleepSub.className = 'text-[10px] text-indigo-600 font-bold';
      }
    } else {
      UI.toggleAutoSleep.disabled = false;
      if (UI.toggleAutoSleepSub) {
        UI.toggleAutoSleepSub.textContent = 'Keep tabs open & put PC to sleep';
        UI.toggleAutoSleepSub.className = 'text-[10px] text-slate-500';
      }
    }
  }
  UI.toggleDryRun.checked = Boolean(engine.dryRunMode);
  if (UI.toggleManualConfirm) {
    UI.toggleManualConfirm.checked = Boolean(engine.manualConfirmationMode);
  }
  if (document.activeElement !== UI.inputDelaySeconds && engine.cooldownTargetSeconds) {
    UI.inputDelaySeconds.value = engine.cooldownTargetSeconds;
  }

  // 8. Developer Terminal Console
  renderTerminalLogs(logs);
}

function updateStatusTile(status, engine) {
  switch (status) {
    case 'STANDBY':
      UI.tileStatusText.textContent = 'STANDBY';
      UI.tileStatusText.className = 'text-base font-bold text-slate-700 mt-0.5';
      UI.tileStatusSub.textContent = 'Enable Auto-Shutdown or Auto-Sleep to begin';
      UI.tileStatusIcon.className = 'h-11 w-11 rounded-xl bg-slate-100 text-slate-500 flex items-center justify-center shrink-0';
      UI.tileStatusIcon.innerHTML = `<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`;
      break;

    case 'IDLE':
      UI.tileStatusText.textContent = 'READY / IDLE';
      UI.tileStatusText.className = 'text-base font-bold text-slate-800 mt-0.5';
      UI.tileStatusSub.textContent = 'Monitoring Antigravity interface';
      UI.tileStatusIcon.className = 'h-11 w-11 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center shrink-0';
      UI.tileStatusIcon.innerHTML = `<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>`;
      break;

    case 'EXECUTING':
      UI.tileStatusText.textContent = 'AI WORKING';
      UI.tileStatusText.className = 'text-base font-bold text-blue-600 animate-pulse mt-0.5';
      const reason = (engine.reasonsBlocked && engine.reasonsBlocked[0]) || 'AI executing prompt';
      UI.tileStatusSub.textContent = reason;
      UI.tileStatusIcon.className = 'h-11 w-11 rounded-xl bg-blue-100 text-blue-700 flex items-center justify-center shrink-0';
      UI.tileStatusIcon.innerHTML = `<svg class="w-5 h-5 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>`;
      break;

    case 'WAITING_INPUT':
      UI.tileStatusText.textContent = 'INPUT REQUIRED';
      UI.tileStatusText.className = 'text-base font-bold text-amber-600 mt-0.5';
      UI.tileStatusSub.textContent = 'AI waiting for user approval';
      UI.tileStatusIcon.className = 'h-11 w-11 rounded-xl bg-amber-50 text-amber-600 flex items-center justify-center shrink-0';
      UI.tileStatusIcon.innerHTML = `<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg>`;
      break;

    case 'VERIFYING':
      UI.tileStatusText.textContent = 'VERIFYING';
      UI.tileStatusText.className = 'text-base font-bold text-sky-600 animate-pulse mt-0.5';
      UI.tileStatusSub.textContent = 'All signals passed; stabilizing';
      UI.tileStatusIcon.className = 'h-11 w-11 rounded-xl bg-sky-50 text-sky-600 flex items-center justify-center shrink-0';
      UI.tileStatusIcon.innerHTML = `<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`;
      break;

    case 'SHUTDOWN_COUNTDOWN':
      const isSleep = engine.autoSleepEnabled;
      UI.tileStatusText.textContent = isSleep ? 'GOING TO SLEEP' : 'SHUTTING DOWN';
      UI.tileStatusText.className = isSleep ? 'text-base font-bold text-indigo-600 animate-pulse mt-0.5' : 'text-base font-bold text-rose-600 animate-pulse mt-0.5';
      UI.tileStatusSub.textContent = `${isSleep ? 'Sleep' : 'Shutdown'} grace period in progress`;
      UI.tileStatusIcon.className = isSleep ? 'h-11 w-11 rounded-xl bg-indigo-100 text-indigo-700 flex items-center justify-center shrink-0' : 'h-11 w-11 rounded-xl bg-rose-100 text-rose-700 flex items-center justify-center shrink-0';
      UI.tileStatusIcon.innerHTML = `<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`;
      break;

    case 'COMPLETED':
      UI.tileStatusText.textContent = 'COMPLETED';
      UI.tileStatusText.className = 'text-base font-bold text-emerald-600 mt-0.5';
      const isAct = engine.autoShutdownEnabled || engine.autoSleepEnabled;
      const actName = engine.autoSleepEnabled ? 'Auto-Sleep' : 'Auto-Shutdown';
      UI.tileStatusSub.textContent = isAct ? `Task verified complete. ${actName} active.` : 'Task verified complete. Turn ON Auto-Shutdown or Auto-Sleep.';
      UI.tileStatusIcon.className = 'h-11 w-11 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center shrink-0';
      UI.tileStatusIcon.innerHTML = `<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>`;
      break;

    case 'ABORTED':
      UI.tileStatusText.textContent = 'ABORTED';
      UI.tileStatusText.className = 'text-base font-bold text-rose-600 mt-0.5';
      UI.tileStatusSub.textContent = 'Shutdown canceled by user';
      UI.tileStatusIcon.className = 'h-11 w-11 rounded-xl bg-rose-50 text-rose-600 flex items-center justify-center shrink-0';
      UI.tileStatusIcon.innerHTML = `<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>`;
      break;

    case 'ERROR':
      UI.tileStatusText.textContent = 'ERROR';
      UI.tileStatusText.className = 'text-base font-bold text-rose-600 mt-0.5';
      UI.tileStatusSub.textContent = 'Execution error halted shutdown';
      UI.tileStatusIcon.className = 'h-11 w-11 rounded-xl bg-rose-50 text-rose-600 flex items-center justify-center shrink-0';
      break;
  }
}

function renderSafetyGates(signals, transcript, playwright, system) {
  let passedCount = 0;

  const setG = (num, ok, statusText) => {
    const card = document.getElementById(`gate${num}`);
    const icon = document.getElementById(`gIcon${num}`);
    const text = document.getElementById(`gText${num}`);
    if (!card || !icon || !text) return;

    if (ok) {
      passedCount++;
      card.className = 'flex items-center justify-between p-2.5 rounded-lg bg-emerald-50/60 border border-emerald-300';
      icon.className = 'h-5 w-5 rounded-md bg-emerald-600 text-white text-[10px] font-bold flex items-center justify-center';
      icon.textContent = '✓';
      text.className = 'text-xs font-mono text-emerald-700 font-bold';
      text.textContent = statusText || 'Ready';
    } else {
      card.className = 'flex items-center justify-between p-2.5 rounded-lg bg-slate-50 border border-slate-200';
      icon.className = 'h-5 w-5 rounded-md bg-slate-200 text-slate-500 text-[10px] font-bold flex items-center justify-center';
      icon.textContent = `${num}`;
      text.className = 'text-xs font-mono text-amber-600 font-medium';
      text.textContent = statusText || 'Working';
    }
  };

  setG(1, signals.transcriptDone, transcript.status === 'COMPLETED' ? 'Done' : 'Active');
  const activeCount = transcript.activeToolCalls ? transcript.activeToolCalls.length : 0;
  setG(2, signals.noActiveTools, activeCount > 0 ? `${activeCount} Active` : 'Done');
  
  let pwText = 'Quiet';
  if (playwright.connected) {
    if (playwright.isGenerating) pwText = 'Stop Active';
    else if (playwright.isBusy) pwText = 'Busy';
    else pwText = 'Ready';
  } else {
    pwText = 'Standby';
  }
  setG(3, signals.playwrightIdle, pwText);
  setG(4, signals.notWaitingForInput, signals.notWaitingForInput ? 'Clear' : 'Waiting Input');
  setG(5, signals.noUnresolvedErrors, signals.noUnresolvedErrors ? '0 Errors' : 'Error');
  setG(6, signals.workspaceQuiet, system.isWorkspaceQuiet ? 'Settled' : `${system.lastFileActivityAgoSeconds || 0}s ago`);

  // Update Score Tile & Badge
  UI.tileGatesScore.textContent = `${passedCount} / 6 Passed`;
  UI.matrixPassedBadge.textContent = `${passedCount} / 6 Passed`;
  if (passedCount === 6) {
    UI.matrixPassedBadge.className = 'text-[11px] font-bold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 border border-emerald-300';
  } else {
    UI.matrixPassedBadge.className = 'text-[11px] font-bold px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 border border-amber-300';
  }
}

function renderTerminalLogs(logs) {
  if (isTerminalCleared) return;

  UI.termEventsCount.textContent = `${logs.length} events logged`;
  if (!logs || logs.length === 0) return;

  const html = logs.map(l => {
    const time = new Date(l.timestamp).toLocaleTimeString();
    let badgeColor = 'text-cyan-400';
    if (l.level === 'SUCCESS') badgeColor = 'text-emerald-400 font-bold';
    else if (l.level === 'WARN') badgeColor = 'text-amber-400 font-bold';
    else if (l.level === 'ERROR') badgeColor = 'text-rose-400 font-bold';
    else if (l.level === 'SAFETY') badgeColor = 'text-purple-400 font-bold';
    else if (l.level === 'AUDIT') badgeColor = 'text-sky-400';

    return `<div class="hover:bg-slate-900/60 py-0.5 px-1 rounded transition-colors">
      <span class="text-slate-500 select-none">[${time}]</span>
      <span class="${badgeColor}">[${l.level}]</span>
      <span class="text-slate-400">[${escapeText(l.category)}]</span>
      <span class="text-slate-200">${escapeText(l.message)}</span>
    </div>`;
  }).join('');

  UI.terminalScreen.innerHTML = html;

  if (UI.chkAutoScroll.checked) {
    UI.terminalScreen.scrollTop = UI.terminalScreen.scrollHeight;
  }
}

function escapeText(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// User Actions: Emergency Stop & Cancel Shutdown
if (UI.btnEmergencyStop) {
  UI.btnEmergencyStop.addEventListener('click', async () => {
    playAudioBeep(650, 0.3);
    await fetch('/api/emergency-stop', { method: 'POST' });
  });
}

if (UI.btnAbortCountdown) {
  UI.btnAbortCountdown.addEventListener('click', async () => {
    playAudioBeep(550, 0.2);
    await fetch('/api/abort-shutdown', { method: 'POST' });
  });
}

// Controls Toggles
if (UI.toggleAutoShutdown) {
  UI.toggleAutoShutdown.addEventListener('change', async (e) => {
    await fetch('/api/toggle-auto-shutdown', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: e.target.checked })
    });
  });
}

if (UI.toggleAutoSleep) {
  UI.toggleAutoSleep.addEventListener('change', async (e) => {
    await fetch('/api/toggle-auto-sleep', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: e.target.checked })
    });
  });
}

if (UI.toggleDryRun) {
  UI.toggleDryRun.addEventListener('change', async (e) => {
    await fetch('/api/toggle-dry-run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: e.target.checked })
    });
  });
}

if (UI.toggleManualConfirm) {
  UI.toggleManualConfirm.addEventListener('change', async (e) => {
    await fetch('/api/toggle-manual-confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: e.target.checked })
    });
  });
}

if (UI.btnSaveDelay) {
  UI.btnSaveDelay.addEventListener('click', async () => {
    const sec = parseInt(UI.inputDelaySeconds.value, 10);
    await fetch('/api/set-verification-delay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seconds: sec })
    });
  });
}

if (UI.btnClearTerminal) {
  UI.btnClearTerminal.addEventListener('click', () => {
    UI.terminalScreen.innerHTML = '<div class="text-slate-600 italic">// Terminal cleared by user. New logs will appear here.</div>';
    isTerminalCleared = true;
    setTimeout(() => { isTerminalCleared = false; }, 3000);
  });
}

// Boot connection
try {
  initDashboard();
} catch (err) {
  console.error('Fatal init error:', err);
}
