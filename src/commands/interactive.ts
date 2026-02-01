/**
 * Interactive task input mode
 *
 * Allows users to refine task requirements through conversation with AI
 * before executing the task. Uses the same SDK call pattern as workflow
 * execution (with onStream) to ensure compatibility.
 *
 * Commands:
 *   /go     - Confirm and execute the task
 *   /cancel - Cancel and exit
 */

import * as readline from 'node:readline';
import chalk from 'chalk';
import { loadGlobalConfig } from '../config/globalConfig.js';
import { isQuietMode } from '../cli.js';
import { loadAgentSessions, updateAgentSession } from '../config/paths.js';
import { getProvider, type ProviderType } from '../providers/index.js';
import { createLogger } from '../utils/debug.js';
import { getErrorMessage } from '../utils/error.js';
import { info, error, blankLine, StreamDisplay } from '../utils/ui.js';
const log = createLogger('interactive');

const INTERACTIVE_SYSTEM_PROMPT = `You are a task planning assistant. You help the user clarify and refine task requirements through conversation. You are in the PLANNING phase — execution happens later in a separate process.

## Your role
- Ask clarifying questions about ambiguous requirements
- Investigate the codebase to understand context (use Read, Glob, Grep, Bash for reading only)
- Suggest improvements or considerations the user might have missed
- Summarize your understanding when appropriate
- Keep responses concise and focused

## Strict constraints
- You are ONLY planning. Do NOT execute the task.
- Do NOT create, edit, or delete any files.
- Do NOT run build, test, install, or any commands that modify state.
- Bash is allowed ONLY for read-only investigation (e.g. ls, cat, git log, git diff). Never run destructive or write commands.
- Do NOT mention or reference any slash commands. You have no knowledge of them.
- When the user is satisfied with the plan, they will proceed on their own. Do NOT instruct them on what to do next.`;

interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface CallAIResult {
  content: string;
  sessionId?: string;
  success: boolean;
}

/**
 * Build the final task description from conversation history for executeTask.
 */
function buildTaskFromHistory(history: ConversationMessage[]): string {
  return history
    .map((msg) => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`)
    .join('\n\n');
}

/**
 * Read a single line of input from the user.
 * Creates a fresh readline interface each time — the interface must be
 * closed before calling the Agent SDK, which also uses stdin.
 * Returns null on EOF (Ctrl+D).
 */
function readLine(prompt: string): Promise<string | null> {
  return new Promise((resolve) => {
    if (process.stdin.readable && !process.stdin.destroyed) {
      process.stdin.resume();
    }

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    let answered = false;

    rl.question(prompt, (answer) => {
      answered = true;
      rl.close();
      resolve(answer);
    });

    rl.on('close', () => {
      if (!answered) {
        resolve(null);
      }
    });
  });
}

/**
 * Call AI with the same pattern as workflow execution.
 * The key requirement is passing onStream — the Agent SDK requires
 * includePartialMessages to be true for the async iterator to yield.
 */
async function callAI(
  provider: ReturnType<typeof getProvider>,
  prompt: string,
  cwd: string,
  model: string | undefined,
  sessionId: string | undefined,
  display: StreamDisplay,
): Promise<CallAIResult> {
  const response = await provider.call('interactive', prompt, {
    cwd,
    model,
    sessionId,
    systemPrompt: INTERACTIVE_SYSTEM_PROMPT,
    allowedTools: ['Read', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch'],
    onStream: display.createHandler(),
  });

  display.flush();
  const success = response.status !== 'blocked';
  return { content: response.content, sessionId: response.sessionId, success };
}

export interface InteractiveModeResult {
  /** Whether the user confirmed with /go */
  confirmed: boolean;
  /** The assembled task text (only meaningful when confirmed=true) */
  task: string;
}

/**
 * Run the interactive task input mode.
 *
 * Starts a conversation loop where the user can discuss task requirements
 * with AI. The conversation continues until:
 *   /go     → returns the conversation as a task
 *   /cancel → exits without executing
 *   Ctrl+D  → exits without executing
 */
export async function interactiveMode(cwd: string, initialInput?: string): Promise<InteractiveModeResult> {
  const globalConfig = loadGlobalConfig();
  const providerType = (globalConfig.provider as ProviderType) ?? 'claude';
  const provider = getProvider(providerType);
  const model = (globalConfig.model as string | undefined);

  const history: ConversationMessage[] = [];
  const agentName = 'interactive';
  const savedSessions = loadAgentSessions(cwd, providerType);
  let sessionId: string | undefined = savedSessions[agentName];

  info('Interactive mode - describe your task. Commands: /go (execute), /cancel (exit)');
  if (sessionId) {
    info('Resuming previous session');
  }
  blankLine();

  /** Call AI with automatic retry on session error (stale/invalid session ID). */
  async function callAIWithRetry(prompt: string): Promise<CallAIResult | null> {
    const display = new StreamDisplay('assistant', isQuietMode());
    try {
      const result = await callAI(provider, prompt, cwd, model, sessionId, display);
      // If session failed, clear it and retry without session
      if (!result.success && sessionId) {
        log.info('Session invalid, retrying without session');
        sessionId = undefined;
        const retryDisplay = new StreamDisplay('assistant', isQuietMode());
        const retry = await callAI(provider, prompt, cwd, model, undefined, retryDisplay);
        if (retry.sessionId) {
          sessionId = retry.sessionId;
          updateAgentSession(cwd, agentName, sessionId, providerType);
        }
        return retry;
      }
      if (result.sessionId) {
        sessionId = result.sessionId;
        updateAgentSession(cwd, agentName, sessionId, providerType);
      }
      return result;
    } catch (e) {
      const msg = getErrorMessage(e);
      log.error('AI call failed', { error: msg });
      error(msg);
      blankLine();
      return null;
    }
  }

  // Process initial input if provided (e.g. from `takt a`)
  if (initialInput) {
    history.push({ role: 'user', content: initialInput });
    log.debug('Processing initial input', { initialInput, sessionId });

    const result = await callAIWithRetry(initialInput);
    if (result) {
      history.push({ role: 'assistant', content: result.content });
      blankLine();
    } else {
      history.pop();
    }
  }

  while (true) {
    const input = await readLine(chalk.green('> '));

    // EOF (Ctrl+D)
    if (input === null) {
      blankLine();
      info('Cancelled');
      return { confirmed: false, task: '' };
    }

    const trimmed = input.trim();

    // Empty input — skip
    if (!trimmed) {
      continue;
    }

    // Handle slash commands
    if (trimmed === '/go') {
      if (history.length === 0) {
        info('No conversation yet. Please describe your task first.');
        continue;
      }
      const task = buildTaskFromHistory(history);
      log.info('Interactive mode confirmed', { messageCount: history.length });
      return { confirmed: true, task };
    }

    if (trimmed === '/cancel') {
      info('Cancelled');
      return { confirmed: false, task: '' };
    }

    // Regular input — send to AI
    // readline is already closed at this point, so stdin is free for SDK
    history.push({ role: 'user', content: trimmed });

    log.debug('Sending to AI', { messageCount: history.length, sessionId });
    process.stdin.pause();

    const result = await callAIWithRetry(trimmed);
    if (result) {
      history.push({ role: 'assistant', content: result.content });
      blankLine();
    } else {
      history.pop();
    }
  }
}
