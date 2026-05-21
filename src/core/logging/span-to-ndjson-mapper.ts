import type {
  NdjsonRecord,
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

export function mapSpanStartToNdjson(span: SpanSnapshot): NdjsonRecord | undefined {
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
  return undefined;
}

function mapWorkflowEnd(span: SpanSnapshot): TerminalWorkflowRecord | undefined {
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

function optionalString<K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> {
  return value !== undefined ? { [key]: value } as Partial<Record<K, string>> : {};
}

function getTimestamp(time: readonly [number, number] | undefined): string {
  if (!time) {
    return new Date().toISOString();
  }
  const [seconds, nanoseconds] = time;
  return new Date((seconds * 1000) + Math.floor(nanoseconds / 1_000_000)).toISOString();
}
