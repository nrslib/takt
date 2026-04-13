import { existsSync, readFileSync } from 'node:fs';
import type { NdjsonRecord, NdjsonWorkflowStackEntry, PromptLogRecord } from '../../../shared/utils/index.js';
import {
  buildPhaseExecutionId,
  parsePhaseExecutionId,
} from '../../../shared/utils/phaseExecutionId.js';
import type {
  TraceStep,
  TracePhase,
} from './traceReportTypes.js';
import { buildWorkflowStepScopeKey } from './workflowStepScope.js';

interface PromptRecord extends PromptLogRecord {
  timestamp: string;
}

interface BuildTraceResult {
  traceStartedAt: string;
  steps: TraceStep[];
}

export function parseJsonl<T>(path: string): T[] {
  if (!existsSync(path)) {
    return [];
  }
  const lines = readFileSync(path, 'utf-8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.map((line) => JSON.parse(line) as T);
}

function stepScopeKey(step: string, stack: NdjsonWorkflowStackEntry[] | undefined): string {
  return buildWorkflowStepScopeKey(step, stack);
}

function stepKey(step: string, iteration: number, stack: NdjsonWorkflowStackEntry[] | undefined): string {
  return `${stepScopeKey(step, stack)}:${iteration}`;
}

function createPhaseExecutionId(
  step: string,
  iteration: number,
  phase: 1 | 2 | 3,
  counters: Map<string, number>,
): string {
  const key = `${step}:${iteration}:${phase}`;
  const current = counters.get(key) ?? 0;
  const next = current + 1;
  counters.set(key, next);
  return buildPhaseExecutionId({
    step,
    iteration,
    phase,
    sequence: next,
  });
}

function parsePhaseExecutionKey(
  phaseExecutionId: string,
): { step: string; iteration: number } | undefined {
  const parsed = parsePhaseExecutionId(phaseExecutionId);
  if (!parsed) {
    return undefined;
  }
  return { step: parsed.step, iteration: parsed.iteration };
}

function ensureStep(
  stepsByKey: Map<string, TraceStep>,
  step: string,
  iteration: number,
  timestamp: string,
  fallbackPersona: string,
  workflow?: string,
  stack?: NdjsonWorkflowStackEntry[],
): TraceStep {
  const key = stepKey(step, iteration, stack);
  const existing = stepsByKey.get(key);
  if (existing) {
    return existing;
  }
  const traceStep: TraceStep = {
    step,
    persona: fallbackPersona,
    iteration,
    workflow,
    stack,
    startedAt: timestamp,
    phases: [],
  };
  stepsByKey.set(key, traceStep);
  return traceStep;
}

export function buildTraceFromRecords(
  records: NdjsonRecord[],
  promptRecords: PromptRecord[],
  defaultEndTime: string,
): BuildTraceResult {
  const promptByExecutionId = new Map<string, PromptRecord>();
  for (const prompt of promptRecords) {
    if (prompt.phaseExecutionId) {
      promptByExecutionId.set(prompt.phaseExecutionId, prompt);
    }
  }

  const stepsByKey = new Map<string, TraceStep>();
  const phasesByExecutionId = new Map<string, { step: TraceStep; index: number }>();
  const phaseExecutionCounters = new Map<string, number>();
  const latestIterationByStepScope = new Map<string, number>();

  let traceStartedAt = '';

  for (const record of records) {
    if (!traceStartedAt && record.type === 'workflow_start') {
      traceStartedAt = record.startTime;
      continue;
    }

    if (record.type === 'step_start') {
      latestIterationByStepScope.set(stepScopeKey(record.step, record.stack), record.iteration);
      const traceStep = ensureStep(
        stepsByKey,
        record.step,
        record.iteration,
        record.timestamp,
        record.persona,
        record.workflow,
        record.stack,
      );
      traceStep.persona = record.persona;
      traceStep.workflow = record.workflow;
      traceStep.stack = record.stack;
      traceStep.instruction = record.instruction;
      continue;
    }

    if (record.type === 'step_complete') {
      if (record.iteration == null) {
        throw new Error(`Missing iteration for step_complete: ${record.step}`);
      }
      const traceStep = ensureStep(
        stepsByKey,
        record.step,
        record.iteration,
        record.timestamp,
        record.persona,
        record.workflow,
        record.stack,
      );
      traceStep.completedAt = record.timestamp;
      traceStep.workflow = record.workflow;
      traceStep.stack = record.stack;
      traceStep.result = {
        status: record.status,
        content: record.content,
        error: record.error,
        matchedRuleIndex: record.matchedRuleIndex,
        matchedRuleMethod: record.matchedRuleMethod,
        matchMethod: record.matchMethod,
      };
      continue;
    }

    if (record.type === 'phase_start') {
      const iteration = record.iteration ?? latestIterationByStepScope.get(stepScopeKey(record.step, record.stack));
      if (iteration == null) {
        throw new Error(`Missing iteration for phase_start: ${record.step}:${record.phase}`);
      }
      const traceStep = ensureStep(
        stepsByKey,
        record.step,
        iteration,
        record.timestamp,
        record.step,
        record.workflow,
        record.stack,
      );
      const resolvedExecutionId =
        record.phaseExecutionId
        ?? createPhaseExecutionId(record.step, iteration, record.phase, phaseExecutionCounters);
      const prompt = promptByExecutionId.get(resolvedExecutionId);
      const phase: TracePhase = {
        phaseExecutionId: resolvedExecutionId,
        phase: record.phase,
        phaseName: record.phaseName,
        instruction: record.instruction ?? record.userInstruction ?? prompt?.userInstruction ?? '',
        systemPrompt: record.systemPrompt ?? prompt?.systemPrompt ?? '',
        userInstruction: record.userInstruction ?? prompt?.userInstruction ?? record.instruction ?? '',
        startedAt: record.timestamp,
      };
      traceStep.phases.push(phase);
      phasesByExecutionId.set(resolvedExecutionId, {
        step: traceStep,
        index: traceStep.phases.length - 1,
      });
      continue;
    }

    if (record.type === 'phase_complete') {
      const iterationFromId = record.phaseExecutionId
        ? parsePhaseExecutionKey(record.phaseExecutionId)?.iteration
        : undefined;
      const iteration =
        record.iteration
        ?? iterationFromId
        ?? latestIterationByStepScope.get(stepScopeKey(record.step, record.stack));
      if (iteration == null) {
        throw new Error(`Missing iteration for phase_complete: ${record.step}:${record.phase}`);
      }
      const resolvedExecutionId =
        record.phaseExecutionId
        ?? createPhaseExecutionId(record.step, iteration, record.phase, phaseExecutionCounters);
      const phaseRef = phasesByExecutionId.get(resolvedExecutionId);
      if (!phaseRef) {
        throw new Error(`Missing phase_start before phase_complete: ${resolvedExecutionId}`);
      }
      const existing = phaseRef.step.phases[phaseRef.index];
      if (!existing) {
        throw new Error(`Missing phase state for completion: ${resolvedExecutionId}`);
      }
      const prompt = promptByExecutionId.get(resolvedExecutionId);
      phaseRef.step.phases[phaseRef.index] = {
        ...existing,
        instruction: existing.instruction || prompt?.userInstruction || '',
        systemPrompt: prompt?.systemPrompt ?? existing.systemPrompt,
        userInstruction: prompt?.userInstruction ?? existing.userInstruction,
        response: record.content,
        status: record.status,
        error: record.error,
        completedAt: record.timestamp,
      };
      continue;
    }

    if (record.type === 'phase_judge_stage') {
      const phaseRef = record.phaseExecutionId
        ? phasesByExecutionId.get(record.phaseExecutionId)
        : undefined;
      if (!phaseRef) {
        continue;
      }
      const existing = phaseRef.step.phases[phaseRef.index];
      if (!existing) {
        continue;
      }
      phaseRef.step.phases[phaseRef.index] = {
        ...existing,
        judgeStages: [
          ...(existing.judgeStages ?? []),
          {
            stage: record.stage,
            method: record.method,
            status: record.status,
            instruction: record.instruction,
            response: record.response,
          },
        ],
      };
    }
  }

  const steps = [...stepsByKey.values()].sort((a, b) => {
    const byStart = a.startedAt.localeCompare(b.startedAt);
    if (byStart !== 0) {
      return byStart;
    }
    return a.iteration - b.iteration;
  });

  return {
    traceStartedAt: traceStartedAt || defaultEndTime,
    steps,
  };
}

export type { PromptRecord };
