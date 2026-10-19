import { readFile } from 'node:fs/promises';
import { USAGE_MISSING_REASONS } from '../../core/logging/contracts.js';
import type { ProviderUsageSnapshot } from '../../core/models/index.js';
import { createLogger, getErrorMessage } from '../../shared/utils/index.js';

const log = createLogger('devin-export');

export const DEVIN_SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

export interface DevinExportData {
  sessionId?: string;
  providerUsage: ProviderUsageSnapshot;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

// `final_metrics` is cumulative over the whole session including resumed
// turns, so this turn's usage is the sum of `metrics` over the `agent` steps
// after the last `user` step.
function extractProviderUsage(parsed: Record<string, unknown>): ProviderUsageSnapshot {
  const steps = parsed.steps;
  if (!Array.isArray(steps)) {
    return { usageMissing: true, reason: USAGE_MISSING_REASONS.TOKENS_MISSING };
  }

  let lastUserStepIndex = -1;
  for (let i = steps.length - 1; i >= 0; i--) {
    if (isRecord(steps[i]) && steps[i].source === 'user') {
      lastUserStepIndex = i;
      break;
    }
  }

  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens: number | undefined;
  let foundMetrics = false;
  for (const step of steps.slice(lastUserStepIndex + 1)) {
    if (!isRecord(step) || step.source !== 'agent' || !isRecord(step.metrics)) {
      continue;
    }
    const promptTokens = toNumber(step.metrics.prompt_tokens);
    const completionTokens = toNumber(step.metrics.completion_tokens);
    if (promptTokens === undefined && completionTokens === undefined) {
      continue;
    }
    foundMetrics = true;
    inputTokens += promptTokens ?? 0;
    outputTokens += completionTokens ?? 0;
    const cachedTokens = toNumber(step.metrics.cached_tokens);
    if (cachedTokens !== undefined) {
      cachedInputTokens = (cachedInputTokens ?? 0) + cachedTokens;
    }
  }

  if (!foundMetrics) {
    return { usageMissing: true, reason: USAGE_MISSING_REASONS.TOKENS_MISSING };
  }

  const providerUsage: ProviderUsageSnapshot = {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    usageMissing: false,
  };
  if (cachedInputTokens !== undefined) {
    providerUsage.cachedInputTokens = cachedInputTokens;
  }
  return providerUsage;
}

// `--export` writes the session transcript (ATIF format) after each turn,
// including the real `session_id`. Reading it back is the only reliable way to
// learn a new session's ID in print mode: the ID is bound to this exact
// process, so parallel steps sharing a working directory can never pick up
// each other's session. A missing or malformed export (failed turn, CLI
// change) leaves the session unresolved — the next phase then simply starts a
// fresh session.
export async function readDevinExport(exportFilePath: string): Promise<DevinExportData | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(exportFilePath, 'utf-8'));
  } catch (error) {
    log.debug('Failed to read Devin session export', { error: getErrorMessage(error) });
    return undefined;
  }
  if (!isRecord(parsed)) {
    log.debug('Devin session export is not a JSON object');
    return undefined;
  }
  const rawSessionId = parsed.session_id;
  const sessionId = typeof rawSessionId === 'string' && DEVIN_SESSION_ID_PATTERN.test(rawSessionId)
    ? rawSessionId
    : undefined;
  return { sessionId, providerUsage: extractProviderUsage(parsed) };
}
