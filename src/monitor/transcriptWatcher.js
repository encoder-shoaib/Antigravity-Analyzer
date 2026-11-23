const fs = require('fs');
const path = require('path');
const config = require('../../config');
const logger = require('../utils/logger');
const eventBus = require('../utils/eventBus');

class TranscriptWatcher {
  constructor(customBrainDir) {
    this.brainDir = customBrainDir || config.BRAIN_DIR;
    this.activeConversationId = null;
    this.activeTranscriptPath = null;
    this.lastByteOffset = 0;
    this.pollInterval = null;
    this.fileWatcher = null;

    this.state = {
      currentPrompt: null,
      promptTimestamp: null,
      status: 'IDLE', // IDLE, RUNNING, WAITING_INPUT, COMPLETED, ERROR
      stepIndex: 0,
      activeToolCalls: [],
      toolHistory: [],
      isTurnComplete: false,
      waitingForUserInput: false,
      lastError: null,
      lastEventTimestamp: null
    };
  }

  start() {
    logger.info('TranscriptWatcher', `Starting transcript monitor on: ${this.brainDir}`);
    this.findActiveConversation();

    // Poll every 500ms to catch updates even if fs.watch misses in some OS environments
    this.pollInterval = setInterval(() => {
      this.poll();
    }, 500);

    return this;
  }

  stop() {
    if (this.pollInterval) clearInterval(this.pollInterval);
    if (this.fileWatcher) {
      try { this.fileWatcher.close(); } catch (_) {}
    }
    logger.info('TranscriptWatcher', 'Transcript monitor stopped.');
  }

  findActiveConversation() {
    try {
      if (!fs.existsSync(this.brainDir)) {
        logger.warn('TranscriptWatcher', `Brain directory not found at ${this.brainDir}. Waiting for Antigravity session...`);
        return null;
      }

      const entries = fs.readdirSync(this.brainDir, { withFileTypes: true });
      let newestTime = 0;
      let newestConvId = null;
      let newestTranscript = null;

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const transcriptPath = path.join(this.brainDir, entry.name, '.system_generated', 'logs', 'transcript.jsonl');
        if (fs.existsSync(transcriptPath)) {
          const stat = fs.statSync(transcriptPath);
          if (stat.mtimeMs > newestTime) {
            newestTime = stat.mtimeMs;
            newestConvId = entry.name;
            newestTranscript = transcriptPath;
          }
        }
      }

      if (newestConvId && newestConvId !== this.activeConversationId) {
        this.activeConversationId = newestConvId;
        this.activeTranscriptPath = newestTranscript;
        this.lastByteOffset = 0;
        this.watchFile(newestTranscript);
        this.readNewLines(true); // initial replay scan
      }

      return this.activeConversationId;
    } catch (err) {
      logger.error('TranscriptWatcher', `Error finding active conversation: ${err.message}`);
      return null;
    }
  }

  watchFile(filePath) {
    if (this.fileWatcher) {
      try { this.fileWatcher.close(); } catch (_) {}
    }
    try {
      this.fileWatcher = fs.watch(filePath, (eventType) => {
        if (eventType === 'change') {
          this.readNewLines(false);
        }
      });
    } catch (err) {
      logger.warn('TranscriptWatcher', `fs.watch failed on ${filePath}, relying on polling: ${err.message}`);
    }
  }

  poll() {
    // Check if there's a newer conversation created
    this.findActiveConversation();

    if (this.activeTranscriptPath && fs.existsSync(this.activeTranscriptPath)) {
      const stat = fs.statSync(this.activeTranscriptPath);
      if (stat.size > this.lastByteOffset) {
        this.readNewLines(false);
      }
    }
  }

  readNewLines(isInitial = false) {
    if (!this.activeTranscriptPath || !fs.existsSync(this.activeTranscriptPath)) return;

    try {
      const stat = fs.statSync(this.activeTranscriptPath);
      if (stat.size < this.lastByteOffset) {
        // File was truncated or rotated
        this.lastByteOffset = 0;
      }
      if (stat.size === this.lastByteOffset) return;

      const fd = fs.openSync(this.activeTranscriptPath, 'r');
      const bufferLength = stat.size - this.lastByteOffset;
      const buffer = Buffer.alloc(bufferLength);
      fs.readSync(fd, buffer, 0, bufferLength, this.lastByteOffset);
      fs.closeSync(fd);

      const text = buffer.toString('utf8');
      const lastNewline = text.lastIndexOf('\n');
      if (lastNewline === -1) {
        // Incomplete line buffer, wait for next tick
        return;
      }

      const completeText = text.slice(0, lastNewline + 1);
      this.lastByteOffset += Buffer.byteLength(completeText, 'utf8');

      const lines = completeText.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const entry = JSON.parse(trimmed);
          this.processEntry(entry, isInitial);
        } catch (_) {
          // malformed line
        }
      }

      if (isInitial) {
        logger.info('TranscriptWatcher', `Attached to active conversation: ${this.activeConversationId} (Synced at step ${this.state.stepIndex})`);
        if (this.state.currentPrompt) {
          logger.info('TranscriptWatcher', `Current prompt: "${this.state.currentPrompt.slice(0, 80)}" [Status: ${this.state.status}]`);
        }
      }
    } catch (err) {
      logger.error('TranscriptWatcher', `Error reading transcript lines: ${err.message}`);
    }
  }

  processEntry(entry, isReplay = false) {
    this.state.lastEventTimestamp = entry.created_at || new Date().toISOString();
    if (typeof entry.step_index === 'number') {
      this.state.stepIndex = entry.step_index;
    }

    // 1. Detect User Prompt Submission
    if (entry.source === 'USER_EXPLICIT' && entry.type === 'USER_INPUT') {
      let promptText = entry.content || '';
      // Extract prompt text from <USER_REQUEST> if present
      const reqMatch = promptText.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
      if (reqMatch) {
        promptText = reqMatch[1].trim();
      }

      this.state.currentPrompt = promptText;
      this.state.promptTimestamp = entry.created_at || new Date().toISOString();
      this.state.status = 'RUNNING';
      this.state.isTurnComplete = false;
      this.state.waitingForUserInput = false;
      this.state.activeToolCalls = [];
      this.state.lastError = null;

      if (!isReplay) {
        logger.audit('TranscriptWatcher', `New prompt detected: "${promptText.slice(0, 80)}..."`, {
          promptLength: promptText.length,
          timestamp: this.state.promptTimestamp,
          stepIndex: this.state.stepIndex
        });

        eventBus.emit('prompt:detected', {
          prompt: promptText,
          timestamp: this.state.promptTimestamp,
          conversationId: this.activeConversationId
        });
      }
      return;
    }

    // 2. Detect Tool Execution
    if (entry.source === 'MODEL' && entry.type === 'PLANNER_RESPONSE') {
      if (Array.isArray(entry.tool_calls) && entry.tool_calls.length > 0) {
        this.state.status = 'RUNNING';
        this.state.isTurnComplete = false;
        this.state.activeToolCalls = entry.tool_calls.map(tc => ({
          name: tc.name,
          args: tc.args,
          startedAt: entry.created_at
        }));

        for (const tc of entry.tool_calls) {
          const summary = tc.args?.toolSummary || tc.args?.CommandLine || tc.name;
          if (!isReplay) {
            logger.info('TranscriptWatcher', `Tool Call: ${tc.name} -> ${summary}`);
          }
          this.state.toolHistory.push({
            name: tc.name,
            summary,
            timestamp: entry.created_at
          });
          if (this.state.toolHistory.length > 50) this.state.toolHistory.shift();
        }

        // Check if one of the tool calls is explicitly asking the user a question
        const isAskingQuestion = entry.tool_calls.some(tc => 
          tc.name === 'ask_question' || (typeof tc.name === 'string' && tc.name.endsWith(':ask_question'))
        );
        if (isAskingQuestion) {
          this.state.waitingForUserInput = true;
          this.state.status = 'WAITING_INPUT';
          if (!isReplay) {
            logger.safety('TranscriptWatcher', 'Agent is waiting for user response to a question');
            eventBus.emit('agent:waiting_input', {
              reason: 'ask_question',
              stepIndex: this.state.stepIndex
            });
          }
        }

        if (!isReplay) {
          eventBus.emit('tool:active', {
            tools: this.state.activeToolCalls,
            stepIndex: this.state.stepIndex
          });
        }
      } else {
        // Model responded with no tool calls -> Turn is 100% completed!
        this.state.activeToolCalls = [];
        this.state.isTurnComplete = true;
        this.state.waitingForUserInput = false;
        this.state.status = 'COMPLETED';

        if (!isReplay) {
          logger.info('TranscriptWatcher', `Agent finished turn response (Step ${this.state.stepIndex})`);
          eventBus.emit('turn:completed', {
            stepIndex: this.state.stepIndex,
            timestamp: entry.created_at
          });
        }
      }
      return;
    }

    // 3. Detect Tool Output / Generic Results
    if (entry.type === 'GENERIC') {
      // Check for errors in output
      const content = String(entry.content || '');
      if (content.includes('Command exited with code') && !content.includes('code 0')) {
        if (!isReplay) {
          logger.warn('TranscriptWatcher', `Command finished with non-zero exit code: ${content.slice(0, 120)}`);
        }
      }
    }

    // 4. Detect Waiting for User Input / Confirmation
    if (entry.type === 'ASK_QUESTION') {
      this.state.waitingForUserInput = true;
      this.state.status = 'WAITING_INPUT';
      if (!isReplay) {
        logger.safety('TranscriptWatcher', 'Agent is waiting for user response to a question');
        eventBus.emit('agent:waiting_input', {
          reason: 'ask_question',
          stepIndex: this.state.stepIndex
        });
      }
      return;
    }

    // 5. Detect System Errors
    if (entry.source === 'SYSTEM' && entry.status === 'ERROR') {
      this.state.lastError = entry.content || 'System error recorded in transcript';
      this.state.status = 'ERROR';
      if (!isReplay) {
        logger.error('TranscriptWatcher', `Transcript system error: ${this.state.lastError}`);
        eventBus.emit('error:detected', {
          error: this.state.lastError,
          stepIndex: this.state.stepIndex
        });
      }
    }
  }

  getState() {
    return {
      conversationId: this.activeConversationId,
      ...this.state
    };
  }
}

module.exports = TranscriptWatcher;
