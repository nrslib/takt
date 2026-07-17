import type { ProviderType } from '../../shared/types/provider.js';
import { normalizeLogMetadata as normalizeMetadata } from '../../shared/utils/logMetadata.js';
import type { ProviderUsageSnapshot } from '../models/response.js';
import { USAGE_MISSING_REASONS, type UsageMissingReason } from './contracts.js';

export type StepType = 'normal' | 'parallel' | 'arpeggio' | 'team_leader' | 'workflow_call';

export interface UsageEventLogRecord {
  run_id: string;
  session_id: string;
  provider: ProviderType;
  provider_model: string;
  step: string;
  step_type: StepType;
  timestamp: string;
  success: boolean;
  usage_missing: boolean;
  reason?: UsageMissingReason;
  usage: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    cached_input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

export type UsageEventPayload = Pick<UsageEventLogRecord, 'usage_missing' | 'reason' | 'usage'>;

interface UsageEventMeta {
  runId: string;
  sessionId: string;
  provider: ProviderType;
  providerModel: string;
  step: string;
  stepType: StepType;
}

interface BuildUsageRecordParams {
  success: boolean;
  usage: ProviderUsageSnapshot;
  timestamp?: Date;
}

function assertFiniteNumber(value: number | undefined, field: string): void {
  if (!Number.isFinite(value)) {
    throw new Error(`[usage-events] ${field} is required`);
  }
}

function assertUsageMissingReason(value: string): UsageMissingReason {
  for (const reason of Object.values(USAGE_MISSING_REASONS)) {
    if (value === reason) {
      return value;
    }
  }
  throw new Error('[usage-events] reason is invalid');
}

export function buildUsageEventRecord(
  meta: UsageEventMeta,
  params: BuildUsageRecordParams,
): UsageEventLogRecord {
  const payload = buildUsageEventPayload(params.usage);
  return {
    run_id: normalizeMetadata(meta.runId),
    session_id: normalizeMetadata(meta.sessionId),
    provider: meta.provider,
    provider_model: normalizeMetadata(meta.providerModel),
    step: normalizeMetadata(meta.step),
    step_type: meta.stepType,
    timestamp: (params.timestamp ?? new Date()).toISOString(),
    success: params.success,
    ...payload,
  };
}

export function buildUsageEventPayload(usageSnapshot: ProviderUsageSnapshot): UsageEventPayload {
  if (usageSnapshot.usageMissing) {
    if (typeof usageSnapshot.reason !== 'string' || usageSnapshot.reason.length === 0) {
      throw new Error('[usage-events] reason is required when usageMissing=true');
    }
    return {
      usage_missing: true,
      reason: assertUsageMissingReason(usageSnapshot.reason),
      usage: {},
    };
  }

  assertFiniteNumber(usageSnapshot.inputTokens, 'usage.inputTokens');
  assertFiniteNumber(usageSnapshot.outputTokens, 'usage.outputTokens');
  assertFiniteNumber(usageSnapshot.totalTokens, 'usage.totalTokens');

  return {
    usage_missing: false,
    usage: {
      input_tokens: usageSnapshot.inputTokens,
      output_tokens: usageSnapshot.outputTokens,
      total_tokens: usageSnapshot.totalTokens,
      ...(Number.isFinite(usageSnapshot.cachedInputTokens)
        ? { cached_input_tokens: usageSnapshot.cachedInputTokens }
        : {}),
      ...(Number.isFinite(usageSnapshot.cacheCreationInputTokens)
        ? { cache_creation_input_tokens: usageSnapshot.cacheCreationInputTokens }
        : {}),
      ...(Number.isFinite(usageSnapshot.cacheReadInputTokens)
        ? { cache_read_input_tokens: usageSnapshot.cacheReadInputTokens }
        : {}),
    },
  };
}
