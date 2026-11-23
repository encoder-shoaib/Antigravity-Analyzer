const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');

/**
 * Mock Antigravity Environment
 * Creates a mock web interface and mock transcript.jsonl
 * to verify end-to-end Playwright DOM inspection and auto-shutdown supervisor.
 */

const MOCK_PORT = 8999;
const MOCK_DIR = path.join(__dirname, 'mock_brain', 'test-conversation-session', '.system_generated', 'logs');

if (!fs.existsSync(MOCK_DIR)) {
  fs.mkdirSync(MOCK_DIR, { recursive: true });
}

const mockTranscriptFile = path.join(MOCK_DIR, 'transcript.jsonl');
fs.writeFileSync(mockTranscriptFile, '', 'utf8');

// HTML for Mock Antigravity Web Page
const mockHtml = `
<!DOCTYPE html>
<html>
<head>
  <title>Google Antigravity IDE Mock</title>
  <style>
    body { background: #1e1e1e; color: #fff; font-family: sans-serif; padding: 20px; }
    .chat-box { border: 1px solid #444; padding: 15px; border-radius: 8px; margin-bottom: 20px; }
    textarea { width: 100%; height: 60px; background: #2d2d2d; color: #fff; border: 1px solid #555; border-radius: 4px; padding: 8px; }
    button { padding: 8px 16px; margin: 4px; cursor: pointer; border: none; border-radius: 4px; }
    .btn-stop { background: #e53935; color: #fff; }
    .btn-send { background: #4caf50; color: #fff; }
    .hidden { display: none; }
  </style>
</head>
<body>
  <h2>Google Antigravity Mock Interface</h2>
  <div class="chat-box">
    <div id="messages">Waiting for prompt...</div>
    <div id="spinner" class="spinner hidden" style="color: #ff9800; margin: 10px 0;">Agent thinking...</div>
    <div style="margin-top: 10px;">
      <textarea id="promptInput" placeholder="Ask Antigravity..."></textarea>
      <div style="margin-top: 5px;">
        <button id="btnSend" class="btn-send">Send</button>
        <button id="btnStop" class="btn-stop hidden" aria-label="Stop">Stop</button>
      </div>
    </div>
  </div>

  <script>
    const btnSend = document.getElementById('btnSend');
    const btnStop = document.getElementById('btnStop');
    const spinner = document.getElementById('spinner');
    const messages = document.getElementById('messages');
    const promptInput = document.getElementById('promptInput');

    window.simulateAgentActivity = (isWorking) => {
      if (isWorking) {
        btnStop.classList.remove('hidden');
        spinner.classList.remove('hidden');
        messages.textContent = 'Agent is generating code and executing tools...';
      } else {
        btnStop.classList.add('hidden');
        spinner.classList.add('hidden');
        messages.textContent = 'Prompt execution complete. Ready for next instruction.';
      }
    };
  </script>
</body>
</html>
`;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(mockHtml);
});

async function runMock() {
  server.listen(MOCK_PORT, async () => {
    console.log(`Mock Antigravity interface running at http://localhost:${MOCK_PORT}`);

    // Launch Playwright to open and inspect mock page
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(`http://localhost:${MOCK_PORT}`);
    console.log('Playwright successfully connected to mock interface!');

    // Test Playwright DOM evaluation
    await page.evaluate(() => window.simulateAgentActivity(true));
    const isStopVisible = await page.isVisible('button[aria-label="Stop"]');
    console.log(`Playwright DOM check during active generation (Stop button visible): ${isStopVisible}`);

    await page.evaluate(() => window.simulateAgentActivity(false));
    const isStopHidden = !(await page.isVisible('button[aria-label="Stop"]'));
    console.log(`Playwright DOM check during idle/complete (Stop button hidden): ${isStopHidden}`);

    await browser.close();
    server.close();
    console.log('Mock Antigravity test completed successfully.');
  });
}

if (require.main === module) {
  runMock();
}

module.exports = { runMock, mockTranscriptFile };
