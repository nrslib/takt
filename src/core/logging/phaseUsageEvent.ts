import type { SpanSnapshot } from './span-to-ndjson-mapper.js';
import {
  USAGE_MISSING_REASONS,
  type UsageMissingReason,
} from './contracts.js';
import { buildUsageEventPayload } from './usageEvent.js';
import type { ProviderUsageSnapshot } from '../models/response.js';
import { isProviderType, type ProviderType } from '../../shared/types/provider.js';

export type PhaseUsageType =
  | 'phase1_execute'
  | 'phase2_report'
  | 'phase3_structured'
  | 'phase3_tag'
  | 'phase3_fallback';

export type PhaseUsageStepType = 'agent' | 'system' | 'workflow_call';
type PhaseName = 'execute' | 'report' | 'judge';
type JudgeMethod = 'structured_output' | 'phase3_tag' | 'ai_judge';
type JudgeStage = 1 | 2 | 3;

export interface PhaseUsageEventLogRecord {
  run_id: string;
  session_id: string;
  provider: ProviderType;
  provider_model: string;
  step: string;
  step_type: PhaseUsageStepType;
  persona?: string;
  tags?: string[];
  phase: PhaseUsageType;
  phase_name: PhaseName;
  phase_execution_id?: string;
  judge_stage?: JudgeStage;
  judge_method?: JudgeMethod;
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

export interface PhaseUsageEventContext {
  runId: string;
  sessionId: string;
}

interface PhaseUsageMeta {
  provider: ProviderType;
  providerModel: string;
  step: string;
  stepType: PhaseUsageStepType;
  persona?: string;
  tags?: string[];
  phase: PhaseUsageType;
  phaseName: PhaseName;
  phaseExecutionId?: string;
  judgeStage?: JudgeStage;
  judgeMethod?: JudgeMethod;
  success: boolean;
}

export function mapSpanEndToPhaseUsageEvent(
  span: SpanSnapshot,
  context: PhaseUsageEventContext,
): PhaseUsageEventLogRecord | undefined {
  if (span.name.startsWith('phase.')) {
    return mapPhaseSpan(span, context);
  }
  if (span.name.startsWith('judge_stage.')) {
    return mapJudgeStageSpan(span, context);
  }
  return undefined;
}

function mapPhaseSpan(
  span: SpanSnapshot,
  context: PhaseUsageEventContext,
): PhaseUsageEventLogRecord | undefined {
  const phaseNumber = getNumber(span.attributes, 'takt.phase.number');
  const phaseName = getPhaseName(span.attributes, 'takt.phase.name');
  const phase = phaseLabelForPhaseSpan(phaseNumber, phaseName);
  if (!phase || !phaseName) {
    return undefined;
  }

  const common = buildCommonMeta(span);
  if (!common) {
    return undefined;
  }

  return buildRecord(span, context, {
    ...common,
    phase,
    phaseName,
    phaseExecutionId: getString(span.attributes, 'takt.phase.execution_id'),
    success: getString(span.attributes, 'takt.phase.status') === 'done',
  });
}

function mapJudgeStageSpan(
  span: SpanSnapshot,
  context: PhaseUsageEventContext,
): PhaseUsageEventLogRecord | undefined {
  const judgeStage = getJudgeStage(span.attributes, 'takt.judge.stage');
  const judgeMethod = getJudgeMethod(span.attributes, 'takt.judge.method');
  const phase = phaseLabelForJudgeStage(judgeStage);
  if (!phase || !judgeStage || !judgeMethod) {
    return undefined;
  }

  const common = buildCommonMeta(span);
  if (!common) {
    return undefined;
  }

  return buildRecord(span, context, {
    ...common,
    phase,
    phaseName: 'judge',
    phaseExecutionId: getString(span.attributes, 'takt.phase.execution_id'),
    judgeStage,
    judgeMethod,
    success: getString(span.attributes, 'takt.judge.status') === 'done',
  });
}

function buildCommonMeta(
  span: SpanSnapshot,
): Pick<PhaseUsageMeta, 'provider' | 'providerModel' | 'step' | 'stepType' | 'persona' | 'tags'> | undefined {
  const provider = getProvider(span.attributes, 'takt.provider.name');
  const step = getString(span.attributes, 'takt.step.name');
  const stepType = getStepType(span.attributes, 'takt.step.type');
  if (!provider || !step || !stepType) {
    return undefined;
  }

  return {
    provider,
    providerModel: getString(span.attributes, 'takt.model.name') ?? '(default)',
    step,
    stepType,
    persona: getString(span.attributes, 'takt.step.persona'),
    tags: getStringArray(span.attributes, 'takt.step.tags'),
  };
}

function buildRecord(
  span: SpanSnapshot,
  context: PhaseUsageEventContext,
  meta: PhaseUsageMeta,
): PhaseUsageEventLogRecord {
  const usage = extractUsage(span.attributes);
  return {
    run_id: context.runId,
    session_id: context.sessionId,
    provider: meta.provider,
    provider_model: meta.providerModel,
    step: meta.step,
    step_type: meta.stepType,
    ...(meta.persona ? { persona: meta.persona } : {}),
    ...(meta.tags ? { tags: meta.tags } : {}),
    phase: meta.phase,
    phase_name: meta.phaseName,
    ...(meta.phaseExecutionId ? { phase_execution_id: meta.phaseExecutionId } : {}),
    ...(meta.judgeStage ? { judge_stage: meta.judgeStage } : {}),
    ...(meta.judgeMethod ? { judge_method: meta.judgeMethod } : {}),
    timestamp: hrTimeToIso(span.endTime),
    success: meta.success,
    usage_missing: usage.missing,
    ...(usage.reason ? { reason: usage.reason } : {}),
    usage: usage.usage,
  };
}

function extractUsage(attributes: Record<string, unknown>): Pick<PhaseUsageEventLogRecord, 'usage_missing' | 'reason' | 'usage'> & {
  missing: boolean;
} {
  const snapshot = usageSnapshotFromAttributes(attributes);
  const payload = buildUsageEventPayload(snapshot);
  return {
    missing: payload.usage_missing,
    ...payload,
  };
}

function usageSnapshotFromAttributes(attributes: Record<string, unknown>): ProviderUsageSnapshot {
  if (attributes['takt.usage.missing'] === true) {
    return {
      usageMissing: true,
      reason: getUsageMissingReason(attributes['takt.usage.missing_reason']),
    };
  }

  const inputTokens = getNumber(attributes, 'gen_ai.usage.input_tokens');
  const outputTokens = getNumber(attributes, 'gen_ai.usage.output_tokens');
  const totalTokens = getNumber(attributes, 'gen_ai.usage.total_tokens')
    ?? (inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined);

  if (inputTokens === undefined || outputTokens === undefined || totalTokens === undefined) {
    return {
      usageMissing: true,
      reason: hasAnyUsageAttribute(attributes)
        ? USAGE_MISSING_REASONS.TOKENS_MISSING
        : USAGE_MISSING_REASONS.NOT_AVAILABLE,
    };
  }

  return {
    usageMissing: false,
    inputTokens,
    outputTokens,
    totalTokens,
    cachedInputTokens: getNumber(attributes, 'gen_ai.usage.cached_input_tokens'),
    cacheCreationInputTokens: getNumber(attributes, 'gen_ai.usage.cache_creation_input_tokens'),
    cacheReadInputTokens: getNumber(attributes, 'gen_ai.usage.cache_read_input_tokens'),
  };
}

function hasAnyUsageAttribute(attributes: Record<string, unknown>): boolean {
  return Object.keys(attributes).some((key) => key.startsWith('gen_ai.usage.'));
}

function phaseLabelForPhaseSpan(
  phaseNumber: number | undefined,
  phaseName: PhaseName | undefined,
): PhaseUsageType | undefined {
  if (phaseNumber === 1 && phaseName === 'execute') {
    return 'phase1_execute';
  }
  if (phaseNumber === 2 && phaseName === 'report') {
    return 'phase2_report';
  }
  return undefined;
}

function phaseLabelForJudgeStage(stage: JudgeStage | undefined): PhaseUsageType | undefined {
  switch (stage) {
    case 1:
      return 'phase3_structured';
    case 2:
      return 'phase3_tag';
    case 3:
      return 'phase3_fallback';
    default:
      return undefined;
  }
}

function getString(attributes: Record<string, unknown>, key: string): string | undefined {
  const value = attributes[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function getStringArray(attributes: Record<string, unknown>, key: string): string[] | undefined {
  const value = attributes[key];
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  if (!value.every((item): item is string => typeof item === 'string' && item.length > 0)) {
    return undefined;
  }
  return [...value];
}

function getNumber(attributes: Record<string, unknown>, key: string): number | undefined {
  const value = attributes[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function getProvider(attributes: Record<string, unknown>, key: string): ProviderType | undefined {
  const value = getString(attributes, key);
  return isProviderType(value) ? value : undefined;
}

function getStepType(attributes: Record<string, unknown>, key: string): PhaseUsageStepType | undefined {
  const value = getString(attributes, key);
  return value === 'agent'
    || value === 'system'
    || value === 'workflow_call'
    ? value
    : undefined;
}

function getPhaseName(attributes: Record<string, unknown>, key: string): PhaseName | undefined {
  const value = getString(attributes, key);
  return value === 'execute' || value === 'report' || value === 'judge' ? value : undefined;
}

function getJudgeStage(attributes: Record<string, unknown>, key: string): JudgeStage | undefined {
  const value = getNumber(attributes, key);
  return value === 1 || value === 2 || value === 3 ? value : undefined;
}

function getJudgeMethod(attributes: Record<string, unknown>, key: string): JudgeMethod | undefined {
  const value = getString(attributes, key);
  return value === 'structured_output' || value === 'phase3_tag' || value === 'ai_judge' ? value : undefined;
}

function getUsageMissingReason(value: unknown): UsageMissingReason {
  return value === USAGE_MISSING_REASONS.NOT_AVAILABLE
    || value === USAGE_MISSING_REASONS.TOKENS_MISSING
    || value === USAGE_MISSING_REASONS.NOT_SUPPORTED_BY_PROVIDER
    ? value
    : USAGE_MISSING_REASONS.NOT_AVAILABLE;
}

function hrTimeToIso(time: readonly [number, number] | undefined): string {
  if (!time) {
    return new Date().toISOString();
  }
  const [seconds, nanoseconds] = time;
  return new Date((seconds * 1000) + Math.floor(nanoseconds / 1_000_000)).toISOString();
}
