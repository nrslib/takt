import { Buffer } from 'node:buffer';

export interface PhaseExecutionScopeEntry {
  workflow: string;
  workflow_ref?: string;
  step: string;
  kind: 'agent' | 'system' | 'workflow_call';
  call_instance?: number;
}

export interface PhaseExecutionIdParts {
  step: string;
  iteration: number;
  phase: 1 | 2 | 3;
  sequence: number;
  workflowStack?: readonly PhaseExecutionScopeEntry[];
}

export interface ParsedPhaseExecutionIdParts extends PhaseExecutionIdParts {
  scopeKey?: string;
}

const SCOPE_BASE_KEYS = ['workflow', 'step', 'kind'] as const;

function encodeStep(step: string): string {
  return Buffer.from(step, 'utf16le').toString('base64url');
}

function decodeStep(encodedStep: string): string | undefined {
  const bytes = Buffer.from(encodedStep, 'base64url');
  if (bytes.length === 0 || bytes.length % 2 !== 0) {
    return undefined;
  }
  const step = bytes.toString('utf16le');
  return encodeStep(step) === encodedStep ? step : undefined;
}

function canonicalScopeEntry(entry: PhaseExecutionScopeEntry): PhaseExecutionScopeEntry {
  if (entry.workflow.length === 0 || entry.step.length === 0) {
    throw new Error('phaseExecutionId scope requires non-empty workflow and step values');
  }
  if (entry.workflow_ref !== undefined && entry.workflow_ref.length === 0) {
    throw new Error('phaseExecutionId scope requires a non-empty workflow_ref');
  }
  if (entry.kind === 'workflow_call') {
    if (!Number.isSafeInteger(entry.call_instance) || entry.call_instance! <= 0) {
      throw new Error(`phaseExecutionId requires positive call_instance for ${entry.workflow}:${entry.step}`);
    }
    return {
      workflow: entry.workflow,
      ...(entry.workflow_ref === undefined ? {} : { workflow_ref: entry.workflow_ref }),
      step: entry.step,
      kind: entry.kind,
      call_instance: entry.call_instance,
    };
  }
  if ((entry.kind !== 'agent' && entry.kind !== 'system') || entry.call_instance !== undefined) {
    throw new Error(`phaseExecutionId has invalid scope entry for ${entry.workflow}:${entry.step}`);
  }
  return {
    workflow: entry.workflow,
    ...(entry.workflow_ref === undefined ? {} : { workflow_ref: entry.workflow_ref }),
    step: entry.step,
    kind: entry.kind,
  };
}

function buildPhaseScopeKey(stack: readonly PhaseExecutionScopeEntry[] | undefined): string | undefined {
  if (stack === undefined || stack.length === 0) {
    return undefined;
  }
  const scope = stack.map(canonicalScopeEntry);
  return Buffer.from(JSON.stringify(scope), 'utf8').toString('base64url');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseScopeEntry(value: unknown): PhaseExecutionScopeEntry | undefined {
  if (!isRecord(value)) return undefined;
  const expectedKeys = [
    ...SCOPE_BASE_KEYS,
    ...(value.workflow_ref === undefined ? [] : ['workflow_ref']),
    ...(value.kind === 'workflow_call' ? ['call_instance'] : []),
  ];
  const actualKeys = Object.keys(value);
  if (actualKeys.length !== expectedKeys.length || !expectedKeys.every((key) => actualKeys.includes(key))) {
    return undefined;
  }
  if (
    typeof value.workflow !== 'string'
    || typeof value.step !== 'string'
    || value.workflow.length === 0
    || value.step.length === 0
    || (value.workflow_ref !== undefined
      && (typeof value.workflow_ref !== 'string' || value.workflow_ref.length === 0))
  ) {
    return undefined;
  }
  if (value.kind === 'workflow_call') {
    if (!Number.isSafeInteger(value.call_instance) || (value.call_instance as number) <= 0) {
      return undefined;
    }
    return canonicalScopeEntry(value as unknown as PhaseExecutionScopeEntry);
  }
  if (value.kind !== 'agent' && value.kind !== 'system') return undefined;
  return canonicalScopeEntry(value as unknown as PhaseExecutionScopeEntry);
}

function parsePhaseScopeKey(scopeKey: string): PhaseExecutionScopeEntry[] | undefined {
  try {
    const json = Buffer.from(scopeKey, 'base64url').toString('utf8');
    if (Buffer.from(json, 'utf8').toString('base64url') !== scopeKey) return undefined;
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
    const scope = parsed.map(parseScopeEntry);
    if (scope.some((entry) => entry === undefined)) return undefined;
    const canonical = scope as PhaseExecutionScopeEntry[];
    return buildPhaseScopeKey(canonical) === scopeKey ? canonical : undefined;
  } catch {
    return undefined;
  }
}

export function buildPhaseExecutionId(parts: PhaseExecutionIdParts): string {
  if (!parts.step) {
    throw new Error('phaseExecutionId requires step');
  }
  if (!Number.isSafeInteger(parts.iteration) || parts.iteration <= 0) {
    throw new Error(`phaseExecutionId requires positive iteration: ${parts.iteration}`);
  }
  if (parts.phase !== 1 && parts.phase !== 2 && parts.phase !== 3) {
    throw new Error(`phaseExecutionId requires phase 1|2|3: ${parts.phase}`);
  }
  if (!Number.isSafeInteger(parts.sequence) || parts.sequence <= 0) {
    throw new Error(`phaseExecutionId requires positive sequence: ${parts.sequence}`);
  }
  const scopeKey = buildPhaseScopeKey(parts.workflowStack);
  const encodedStep = encodeStep(parts.step);
  return scopeKey
    ? `scope-${scopeKey}:${encodedStep}:${parts.iteration}:${parts.phase}:${parts.sequence}`
    : `${encodedStep}:${parts.iteration}:${parts.phase}:${parts.sequence}`;
}

export function parsePhaseExecutionId(
  phaseExecutionId: string,
): ParsedPhaseExecutionIdParts | undefined {
  const parts = phaseExecutionId.split(':');
  if (parts.length !== 4 && parts.length !== 5) {
    return undefined;
  }
  const [scopePart, step, iterationStr, phaseStr, sequenceStr] = parts.length === 5
    ? parts
    : [undefined, ...parts];
  if (scopePart !== undefined && !scopePart.startsWith('scope-')) {
    return undefined;
  }
  const scopeKey = scopePart?.slice('scope-'.length);
  const workflowStack = scopeKey === undefined ? undefined : parsePhaseScopeKey(scopeKey);
  if (scopeKey !== undefined && workflowStack === undefined) return undefined;
  const decodedStep = decodeStep(step!);
  const iteration = Number(iterationStr);
  const phase = Number(phaseStr);
  const sequence = Number(sequenceStr);
  if (decodedStep === undefined || !Number.isSafeInteger(iteration) || iteration <= 0) {
    return undefined;
  }
  if (!Number.isInteger(phase) || (phase !== 1 && phase !== 2 && phase !== 3)) {
    return undefined;
  }
  if (!Number.isSafeInteger(sequence) || sequence <= 0) {
    return undefined;
  }
  const parsed: ParsedPhaseExecutionIdParts = {
    step: decodedStep,
    iteration,
    phase: phase as 1 | 2 | 3,
    sequence,
    ...(workflowStack === undefined ? {} : { workflowStack }),
    ...(scopeKey === undefined ? {} : { scopeKey }),
  };
  return buildPhaseExecutionId(parsed) === phaseExecutionId ? parsed : undefined;
}
