/**
 * Mock agent client for testing
 *
 * Returns immediate fixed responses without any API calls.
 * Useful for testing workflows without incurring costs or latency.
 */

import { randomUUID } from 'node:crypto';
import type { AgentResponse } from '../../core/models/index.js';
import type { StreamEvent } from '../../shared/types/provider.js';
import { appendPrivateFile } from '../../shared/utils/private-file.js';
import { getScenarioQueue } from './scenario.js';
import type { MockCallOptions, ScenarioEntry } from './types.js';

export type { MockCallOptions };

const RUNTIME_ENV_KEYS = [
  'TMPDIR',
  'TEMP',
  'TMP',
  'TAKT_RUNTIME_TMP',
  'GRADLE_USER_HOME',
  'npm_config_cache',
] as const;

/**
 * Generate a mock session ID
 */
function generateMockSessionId(): string {
  return `mock-session-${randomUUID()}`;
}

function managerTaskResponse(prompt: string): Record<string, unknown> {
  const match = /## Task manifest\n(`{3,})json\n([\s\S]*?)\n\1/u.exec(prompt);
  if (match?.[2] === undefined) {
    throw new Error('Mock manager task response requires an engine task manifest');
  }
  const manifest = JSON.parse(match[2]) as {
    taskId?: unknown;
    rawFindings?: unknown;
  };
  if (typeof manifest.taskId !== 'string' || !Array.isArray(manifest.rawFindings)) {
    throw new Error('Mock manager task response received an invalid raw task manifest');
  }
  return {
    taskId: manifest.taskId,
    decisions: manifest.rawFindings.map((raw) => {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new Error('Mock manager task response received an invalid raw finding');
      }
      const rawFinding = raw as { rawFindingId?: unknown; componentId?: unknown };
      if (typeof rawFinding.rawFindingId !== 'string' || typeof rawFinding.componentId !== 'string') {
        throw new Error('Mock manager task response received an invalid raw finding identity');
      }
      return {
        componentId: rawFinding.componentId,
        rawFindingId: rawFinding.rawFindingId,
        decision: 'new',
        findingId: '',
        evidence: 'Mock manager accepted the new finding.',
      };
    }),
  };
}

function scenarioStructuredOutput(
  entry: ScenarioEntry | undefined,
  prompt: string,
): Record<string, unknown> | undefined {
  if (entry?.mockTaskResponse === 'main_manager_raw_decisions') {
    return managerTaskResponse(prompt);
  }
  return entry?.structuredOutput;
}

function recordMockCall(
  event: 'start' | 'complete',
  personaName: string,
  details?: {
    model?: string;
    status?: AgentResponse['status'];
    aborted?: boolean;
  },
): void {
  const logPath = process.env.TAKT_MOCK_CALL_LOG;
  if (!logPath) {
    return;
  }
  const runtimeEnvironment = Object.fromEntries(
    RUNTIME_ENV_KEYS.flatMap((key) => {
      const value = process.env[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );
  appendPrivateFile(logPath, `${JSON.stringify({
    event,
    provider: 'mock',
    personaName,
    runtimeEnvironment,
    ...details,
  })}\n`);
}

async function delayWithAbort(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}

async function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) {
    throw new Error('Mock scenario wait_for_abort requires an abort signal');
  }
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    signal.addEventListener('abort', () => {
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}

/**
 * Call mock agent - returns immediate fixed response
 */
export async function callMock(
  personaName: string,
  prompt: string,
  options: MockCallOptions
): Promise<AgentResponse> {
  const sessionId = options.sessionId ?? generateMockSessionId();

  // Scenario queue takes priority over explicit options
  const scenarioEntry = getScenarioQueue()?.consume(personaName);
  recordMockCall('start', personaName, {
    model: options.model,
  });

  // Apply deterministic abort gating or an artificial delay when requested.
  if (scenarioEntry?.waitForAbort === true || scenarioEntry?.delayMs) {
    try {
      if (scenarioEntry.waitForAbort === true) {
        await waitForAbort(options.abortSignal);
      } else {
        await delayWithAbort(scenarioEntry.delayMs!, options.abortSignal);
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        recordMockCall('complete', personaName, { status: 'blocked', aborted: true });
        return {
          persona: personaName,
          status: 'blocked',
          content: '[MOCK:ABORTED]\n\nMock response interrupted by abort signal.',
          timestamp: new Date(),
          sessionId,
        };
      }
      throw e;
    }
  }

  const status = scenarioEntry?.status ?? options.mockStatus ?? 'done';
  const statusMarker = `[MOCK:${status.toUpperCase()}]`;
  const allowedToolsSuffix = options.allowedTools && options.allowedTools.length > 0
    ? `\nAllowed tools: ${options.allowedTools.join(', ')}`
    : '';
  const content = scenarioEntry?.content ?? options.mockResponse ??
    `${statusMarker}\n\nMock response for persona "${personaName}".\nPrompt: ${prompt.slice(0, 100)}${prompt.length > 100 ? '...' : ''}${allowedToolsSuffix}`;

  // Emit stream events if callback is provided
  if (options.onStream) {
    const initEvent: StreamEvent = {
      type: 'init',
      data: { model: 'mock-model', sessionId },
    };
    options.onStream(initEvent);

    const textEvent: StreamEvent = {
      type: 'text',
      data: { text: content },
    };
    options.onStream(textEvent);

    const resultEvent: StreamEvent = {
      type: 'result',
      data: { success: true, result: content, sessionId },
    };
    options.onStream(resultEvent);
  }

  recordMockCall('complete', personaName, { status, aborted: false });
  return {
    persona: personaName,
    status,
    content,
    timestamp: new Date(),
    sessionId,
    structuredOutput: scenarioStructuredOutput(scenarioEntry, prompt) ?? options.structuredOutput,
    error: scenarioEntry?.error ?? options.error,
    failureCategory: scenarioEntry?.failureCategory ?? options.failureCategory,
  };
}

/**
 * Call mock agent with custom system prompt (same as callMock for mock provider)
 */
export async function callMockCustom(
  personaName: string,
  prompt: string,
  _systemPrompt: string,
  options: MockCallOptions
): Promise<AgentResponse> {
  // For mock, system prompt is ignored - just return fixed response
  return callMock(personaName, prompt, options);
}
