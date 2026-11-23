# Google Antigravity AI Task Completion Monitor & Auto-Shutdown

A fault-tolerant automation and safety supervision tool built with **Playwright** and **Node.js** that monitors Google Antigravity prompts in real time and automatically shuts down your computer **only after** the submitted prompt has been verified as 100% completed.

---

## 🛡️ Core Philosophy: Safety First

> **The Cardinal Rule**: A simple idle screen or stopped animation is **never** treated as proof of completion. Computer shutdown occurs **ONLY** when the exact submitted prompt is verified as fully completed across multiple independent signals. If verification is uncertain or an error occurs, shutdown is halted and the computer remains on.

---

## 🚀 Key Features

- **Playwright DOM & Browser Supervision**:
  - Connects to Antigravity sessions via Chrome DevTools Protocol (CDP).
  - Inspects UI in real time: tracks Stop buttons, spinners, progress bars, permission modals, and chat input readiness.
  - Automatically performs **graceful browser teardown**: closes all automation-managed tabs and waits for processes to exit before shutdown.

- **Antigravity Brain & Transcript Deep-Tracking**:
  - Real-time watcher of `transcript.jsonl` in Antigravity's local session store.
  - Detects prompt submissions, planning phases, active tool calls, generic tool results, and completion turns.
  - Identifies blocked states, such as `ask_question` or pending terminal approvals.

- **6-Gate Multi-Signal Verification Engine**:
  1. **Transcript Completion Gate**: AI agent produced final response with `DONE` status.
  2. **Active Tool Gate**: Zero tool calls in flight (`run_command`, file writes, etc.).
  3. **Playwright UI Gate**: No Stop button visible, no progress spinner, prompt input enabled.
  4. **Input Gate**: Agent is NOT paused waiting for user input or approval.
  5. **Error Gate**: Zero unresolved errors or command failures.
  6. **System Quiet Gate**: Workspace file modifications settled, zero hanging child processes.

- **Stabilization Cooldown Period**:
  - Configurable verification delay (default: **20 seconds**). All 6 signals must remain continuously green without interruption before shutdown is approved.

- **Grace Period & Emergency Stop**:
  - **60-Second Visual & Audible Countdown** before executing OS shutdown.
  - **Emergency Stop Button**: Instantly cancels countdown, issues `shutdown /a` (Windows abort), and sets state to `ABORTED`.

- **Dry-Run / Safe Simulation Mode**:
  - Enabled by default for testing. Simulates the entire completion, browser closing, and shutdown sequence with audit logs and audio alerts without powering off your PC.

- **Real-Time Web Dashboard**:
  - Accessible at `http://localhost:4321`.
  - Live Server-Sent Events (SSE) data stream.
  - Shows current prompt, execution status, multi-signal checklist, live tool activity, Emergency Stop, and safety toggles.
  - Interactive Simulation Panel to safely test any execution scenario.

---

## 📋 Prerequisites

- **Node.js**: v18.0.0 or higher (v26+ supported)
- **Playwright**: Included in dependencies
- **OS**: Windows (supports native `shutdown /s` and `shutdown /a`)

---

## 📦 Installation & Setup

1. Clone or navigate to the project directory:
   ```powershell
   cd "c:\MY-pRoJeCts\Antigravity Analyzer"
   ```

2. Install dependencies (if not already installed):
   ```powershell
   npm install
   ```

3. (Optional) Run the automated safety test suite:
   ```powershell
   npm test
   ```

---

## 🏃 Running the Monitor

### Option 1: One-Click Windows Launcher (Recommended)
Double-click `start.bat` in the project root folder. It starts the supervisor and opens `http://localhost:4321` automatically in your default browser.

### Option 2: Command Line
Start the supervisor from PowerShell or CMD:
```powershell
npm start
```

Open your browser to:
```
http://localhost:4321
```

### Enabling Playwright CDP on Antigravity IDE (Optional)
If you wish to allow Playwright to directly inspect Antigravity IDE's DOM elements:
Launch Antigravity IDE with remote debugging enabled:
```powershell
"Antigravity IDE.exe" --remote-debugging-port=9222
```
*Note: Even without `--remote-debugging-port`, the monitor operates seamlessly using the Antigravity Brain, Transcript Watcher, and System Settle Watchers.*

---

## ⚙️ Configuration (`config.js`)

You can customize behavior via environment variables or by modifying `config.js`:

| Option | Environment Variable | Default | Description |
|---|---|---|---|
| Dashboard Port | `PORT` | `4321` | HTTP web server port |
| CDP Endpoint | `CDP_ENDPOINT` | `http://127.0.0.1:9222` | Playwright CDP connection URL |
| Verification Delay | `VERIFICATION_DELAY_SECONDS` | `20` | Seconds all signals must stay green |
| Shutdown Grace Period | `SHUTDOWN_GRACE_PERIOD_SECONDS` | `60` | Pre-shutdown countdown seconds |
| Auto-Shutdown Enabled | `AUTO_SHUTDOWN_ENABLED` | `true` | Enable/disable auto-shutdown |
| Dry Run Mode | `DRY_RUN_MODE` | `true` | Safe simulation mode (prevents power off) |
| Manual Confirmation | `MANUAL_CONFIRMATION_MODE` | `false` | Requires user click before shutdown |

---

## 🖥️ Dashboard Overview

- **Current AI Prompt**: Displays the detected user prompt, session ID, and start timestamp.
- **System Supervisor Status**: Real-time state machine indicator (`IDLE`, `EXECUTING`, `WAITING_INPUT`, `VERIFYING`, `COMPLETED`, `SHUTDOWN_COUNTDOWN`, `ABORTED`, `ERROR`).
- **Multi-Signal Safety Matrix**: Visual checklist of all 6 safety gates.
- **Controls & Toggles**:
  - `Auto-Shutdown Guard`: Switch auto-shutdown on/off.
  - `Dry-Run Simulation Mode`: Switch between safe testing and live OS shutdown.
  - `Manual Confirmation`: Force prompt confirmation before countdown.
  - `Stabilization Delay`: Adjust cooldown seconds directly from the UI.
- **EMERGENCY STOP**: Large prominent button to cancel any pending shutdown immediately.
- **Interactive Simulator**: One-click test scenarios to verify how the supervisor handles success, tool execution, user input, and errors.
- **Real-Time Audit Trail**: Persistent system event logs written to `logs/audit.jsonl` and `logs/monitor.log`.

---

## 🧪 Testing & Verification

Run the comprehensive multi-gate safety test suite:
```powershell
npm test
```

Run the Playwright DOM evaluation test with the mock interface:
```powershell
npm run test:mock
```

---

## 📝 License
MIT
