import type {
  NdjsonRecord,
  NdjsonPhaseComplete,
  NdjsonPhaseJudgeStage,
  NdjsonPhaseStart,
  NdjsonStepComplete,
  NdjsonStepStart,
  NdjsonWorkflowAbort,
  NdjsonWorkflowComplete,
  NdjsonWorkflowStackEntry,
} from '../../shared/utils/index.js';
import { AGENT_FAILURE_CATEGORIES, type AgentFailureCategory } from '../../shared/types/agent-failure.js';

export interface SpanSnapshot {
  name: string;
  attributes: Record<string, unknown>;
  startTime?: readonly [number, number];
  endTime?: readonly [number, number];
}

type TerminalWorkflowRecord = NdjsonWorkflowComplete | NdjsonWorkflowAbort;
type PhaseName = NdjsonPhaseStart['phaseName'];
type JudgeStage = NdjsonPhaseJudgeStage['stage'];
type JudgeMethod = NdjsonPhaseJudgeStage['method'];
type JudgeStatus = NdjsonPhaseJudgeStage['status'];

export function mapSpanStartToNdjson(span: SpanSnapshot): NdjsonRecord | undefined {
  if (span.name.startsWith('phase.')) {
    return mapPhaseStart(span);
  }
  if (!span.name.startsWith('step.')) {
    return undefined;
  }
  return mapStepStart(span);
}

export function mapSpanEndToNdjson(span: SpanSnapshot): NdjsonRecord | undefined {
  if (span.name.startsWith('workflow.')) {
    return mapWorkflowEnd(span);
  }
  if (span.name.startsWith('step.')) {
    return mapStepComplete(span);
  }
  if (span.name.startsWith('phase.')) {
    return mapPhaseComplete(span);
  }
  if (span.name.startsWith('judge_stage.')) {
    return mapJudgeStage(span);
  }
  return undefined;
}

function mapWorkflowEnd(span: SpanSnapshot): TerminalWorkflowRecord | undefined {
  const resumeDepth = getNumber(span.attributes, 'takt.workflow.resume_depth') ?? 0;
  if (resumeDepth > 0) {
    return undefined;
  }
  const status = getString(span.attributes, 'takt.workflow.status');
  if (status === undefined || status === 'running') {
    return undefined;
  }
  const iterations = getNumber(span.attributes, 'takt.workflow.iterations') ?? 0;
  const endTime = getTimestamp(span.endTime);

  if (status === 'aborted') {
    return {
      type: 'workflow_abort',
      iterations,
      reason: getString(span.attributes, 'takt.workflow.abort.reason') ?? getString(span.attributes, 'takt.workflow.abort.kind') ?? 'Workflow aborted',
      endTime,
    };
  }

  return {
    type: 'workflow_complete',
    iterations,
    endTime,
  };
}

function mapStepStart(span: SpanSnapshot): NdjsonStepStart | undefined {
  const step = getString(span.attributes, 'takt.step.name');
  const persona = getString(span.attributes, 'takt.step.persona');
  const iteration = getNumber(span.attributes, 'takt.step.iteration');
  if (!step || !persona || iteration == null) {
    return undefined;
  }

  const providerOptions = parseJsonValue(getString(span.attributes, 'takt.provider.options'));
  const providerOptionsSources = parseJsonRecord(getString(span.attributes, 'takt.provider.options_sources'));
  return {
    type: 'step_start',
    step,
    persona,
    iteration,
    timestamp: getTimestamp(span.startTime),
    ...getWorkflowStack(span.attributes),
    ...optionalString('instruction', getString(span.attributes, 'takt.step.instruction')),
    ...optionalString('provider', getString(span.attributes, 'takt.provider.name')),
    ...optionalString('providerSource', getString(span.attributes, 'takt.provider.source')),
    ...optionalString('model', getString(span.attributes, 'takt.model.name')),
    ...optionalString('modelSource', getString(span.attributes, 'takt.model.source')),
    ...(providerOptions !== undefined ? { providerOptions } : {}),
    ...(providerOptionsSources !== undefined ? { providerOptionsSources } : {}),
  };
}

function mapStepComplete(span: SpanSnapshot): NdjsonStepComplete | undefined {
  const step = getString(span.attributes, 'takt.step.name');
  const persona = getString(span.attributes, 'takt.step.result.persona') ?? getString(span.attributes, 'takt.step.persona');
  const iteration = getNumber(span.attributes, 'takt.step.iteration');
  const status = getString(span.attributes, 'takt.step.status');
  if (!step || !persona || iteration == null || !status) {
    return undefined;
  }

  const matchedRuleIndex = getNumber(span.attributes, 'takt.step.result.matched_rule_index');
  const failureCategory = getString(span.attributes, 'takt.step.result.failure_category');
  return {
    type: 'step_complete',
    step,
    persona,
    iteration,
    status,
    content: getString(span.attributes, 'takt.step.result.content') ?? '',
    instruction: getString(span.attributes, 'takt.step.instruction') ?? '',
    ...getWorkflowStack(span.attributes),
    ...(matchedRuleIndex != null ? { matchedRuleIndex } : {}),
    ...optionalString('matchedRuleMethod', getString(span.attributes, 'takt.step.result.matched_rule_method')),
    ...optionalString('matchMethod', getString(span.attributes, 'takt.step.result.match_method')),
    ...optionalString('error', getString(span.attributes, 'takt.step.result.error')),
    ...(isAgentFailureCategory(failureCategory) ? { failureCategory } : {}),
    timestamp: getString(span.attributes, 'takt.step.result.timestamp') ?? getTimestamp(span.endTime),
  };
}

function mapPhaseStart(span: SpanSnapshot): NdjsonPhaseStart | undefined {
  const step = getString(span.attributes, 'takt.step.name');
  const phase = getPhaseNumber(span.attributes, 'takt.phase.number');
  const phaseName = getPhaseName(span.attributes, 'takt.phase.name');
  const phaseExecutionId = getString(span.attributes, 'takt.phase.execution_id');
  const systemPrompt = getString(span.attributes, 'takt.phase.system_prompt');
  const userInstruction = getString(span.attributes, 'takt.phase.user_instruction');
  if (
    !step
    || phase === undefined
    || phaseName === undefined
    || !phaseExecutionId
    || systemPrompt === undefined
    || userInstruction === undefined
  ) {
    return undefined;
  }

  return {
    type: 'phase_start',
    step,
    ...optionalNumber('iteration', getNumber(span.attributes, 'takt.step.iteration')),
    ...getWorkflowStack(span.attributes),
    phase,
    phaseName,
    phaseExecutionId,
    timestamp: getTimestamp(span.startTime),
    ...optionalString('instruction', getString(span.attributes, 'takt.phase.instruction')),
    systemPrompt,
    userInstruction,
  };
}

function mapPhaseComplete(span: SpanSnapshot): NdjsonPhaseComplete | undefined {
  const step = getString(span.attributes, 'takt.step.name');
  const phase = getPhaseNumber(span.attributes, 'takt.phase.number');
  const phaseName = getPhaseName(span.attributes, 'takt.phase.name');
  const phaseExecutionId = getString(span.attributes, 'takt.phase.execution_id');
  const status = getString(span.attributes, 'takt.phase.status');
  if (
    !step
    || phase === undefined
    || phaseName === undefined
    || !phaseExecutionId
    || !status
  ) {
    return undefined;
  }
  // Parity gate, scoped by phase: the canonical log emits phase_complete
  // unconditionally ONLY for the judge phase (its catch fires onPhaseComplete
  // even when prompts never resolved). For execute/report the canonical
  // onPhaseComplete is reached only after prompt parts resolved, so requiring
  // them here avoids emitting an orphaned phase_complete (no preceding
  // phase_start) when the agent throws early. system_prompt/user_instruction
  // are not part of NdjsonPhaseComplete — they are used only as the gate.
  if (phaseName !== 'judge') {
    const systemPrompt = getString(span.attributes, 'takt.phase.system_prompt');
    const userInstruction = getString(span.attributes, 'takt.phase.user_instruction');
    if (systemPrompt === undefined || userInstruction === undefined) {
      return undefined;
    }
  }

  return {
    type: 'phase_complete',
    step,
    ...optionalNumber('iteration', getNumber(span.attributes, 'takt.step.iteration')),
    ...getWorkflowStack(span.attributes),
    phase,
    phaseName,
    phaseExecutionId,
    status,
    ...optionalString('content', getString(span.attributes, 'takt.phase.result.content')),
    timestamp: getTimestamp(span.endTime),
    ...optionalString('error', getString(span.attributes, 'takt.phase.result.error')),
  };
}

function mapJudgeStage(span: SpanSnapshot): NdjsonPhaseJudgeStage | undefined {
  const step = getString(span.attributes, 'takt.step.name');
  const stage = getJudgeStage(span.attributes, 'takt.judge.stage');
  const method = getJudgeMethod(span.attributes, 'takt.judge.method');
  const status = getJudgeStatus(span.attributes, 'takt.judge.status');
  const instruction = getString(span.attributes, 'takt.judge.instruction');
  const response = getString(span.attributes, 'takt.judge.response');
  if (!step || stage === undefined || method === undefined || status === undefined || instruction === undefined || response === undefined) {
    return undefined;
  }

  return {
    type: 'phase_judge_stage',
    step,
    ...optionalNumber('iteration', getNumber(span.attributes, 'takt.step.iteration')),
    ...getWorkflowStack(span.attributes),
    phase: 3,
    phaseName: 'judge',
    ...optionalString('phaseExecutionId', getString(span.attributes, 'takt.phase.execution_id')),
    stage,
    method,
    status,
    instruction,
    response,
    timestamp: getTimestamp(span.endTime),
  };
}

function getWorkflowStack(attributes: Record<string, unknown>): {
  workflow?: string;
  stack?: NdjsonWorkflowStackEntry[];
} {
  const workflow = getString(attributes, 'takt.workflow.current_name');
  const stackJson = getString(attributes, 'takt.workflow.stack');
  const stack = parseWorkflowStack(stackJson);
  return {
    ...(workflow ? { workflow } : {}),
    ...(stack ? { stack } : {}),
  };
}

function parseWorkflowStack(value: string | undefined): NdjsonWorkflowStackEntry[] | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return undefined;
    }
    const stack: NdjsonWorkflowStackEntry[] = [];
    for (const entry of parsed) {
      if (!isWorkflowStackEntry(entry)) {
        return undefined;
      }
      stack.push(entry);
    }
    return stack;
  } catch {
    return undefined;
  }
}

function parseJsonValue(value: string | undefined): unknown {
  if (value === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function parseJsonRecord(value: string | undefined): Record<string, string> | undefined {
  const parsed = parseJsonValue(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined;
  }
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(parsed)) {
    if (typeof item === 'string') {
      result[key] = item;
    }
  }
  return result;
}

function isWorkflowStackEntry(value: unknown): value is NdjsonWorkflowStackEntry {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return typeof entry.workflow === 'string'
    && (entry.workflow_ref === undefined || typeof entry.workflow_ref === 'string')
    && typeof entry.step === 'string'
    && (entry.kind === 'agent' || entry.kind === 'system' || entry.kind === 'workflow_call');
}

function isAgentFailureCategory(value: string | undefined): value is AgentFailureCategory {
  return value === AGENT_FAILURE_CATEGORIES.EXTERNAL_ABORT
    || value === AGENT_FAILURE_CATEGORIES.PART_TIMEOUT
    || value === AGENT_FAILURE_CATEGORIES.PROVIDER_ERROR
    || value === AGENT_FAILURE_CATEGORIES.STREAM_IDLE_TIMEOUT;
}

function getString(attributes: Record<string, unknown>, key: string): string | undefined {
  const value = attributes[key];
  return typeof value === 'string' ? value : undefined;
}

function getNumber(attributes: Record<string, unknown>, key: string): number | undefined {
  const value = attributes[key];
  return typeof value === 'number' ? value : undefined;
}

function getPhaseNumber(attributes: Record<string, unknown>, key: string): 1 | 2 | 3 | undefined {
  const value = getNumber(attributes, key);
  return value === 1 || value === 2 || value === 3 ? value : undefined;
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

function getJudgeStatus(attributes: Record<string, unknown>, key: string): JudgeStatus | undefined {
  const value = getString(attributes, key);
  return value === 'done' || value === 'error' || value === 'skipped' ? value : undefined;
}

function optionalString<K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> {
  return value !== undefined ? { [key]: value } as Partial<Record<K, string>> : {};
}

function optionalNumber<K extends string>(key: K, value: number | undefined): Partial<Record<K, number>> {
  return value !== undefined ? { [key]: value } as Partial<Record<K, number>> : {};
}

function getTimestamp(time: readonly [number, number] | undefined): string {
  if (!time) {
    return new Date().toISOString();
  }
  const [seconds, nanoseconds] = time;
  return new Date((seconds * 1000) + Math.floor(nanoseconds / 1_000_000)).toISOString();
}
