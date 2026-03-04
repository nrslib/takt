import { existsSync, readFileSync } from 'node:fs';
import type { NdjsonRecord, PromptLogRecord } from '../../../shared/utils/index.js';
import {
  buildPhaseExecutionId,
  parsePhaseExecutionId,
} from '../../../shared/utils/phaseExecutionId.js';
import type {
  TraceMovement,
  TracePhase,
} from './traceReportTypes.js';

interface PromptRecord extends PromptLogRecord {
  timestamp: string;
}

interface BuildTraceResult {
  traceStartedAt: string;
  movements: TraceMovement[];
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

function movementKey(step: string, iteration: number): string {
  return `${step}:${iteration}`;
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

function ensureMovement(
  movementsByKey: Map<string, TraceMovement>,
  step: string,
  iteration: number,
  timestamp: string,
  fallbackPersona: string,
): TraceMovement {
  const key = movementKey(step, iteration);
  const existing = movementsByKey.get(key);
  if (existing) {
    return existing;
  }
  const movement: TraceMovement = {
    step,
    persona: fallbackPersona,
    iteration,
    startedAt: timestamp,
    phases: [],
  };
  movementsByKey.set(key, movement);
  return movement;
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

  const movementsByKey = new Map<string, TraceMovement>();
  const phasesByExecutionId = new Map<string, { movement: TraceMovement; index: number }>();
  const phaseExecutionCounters = new Map<string, number>();
  const latestIterationByStep = new Map<string, number>();

  let traceStartedAt = '';

  for (const record of records) {
    if (!traceStartedAt && record.type === 'piece_start') {
      traceStartedAt = record.startTime;
      continue;
    }

    if (record.type === 'step_start') {
      latestIterationByStep.set(record.step, record.iteration);
      const movement = ensureMovement(
        movementsByKey,
        record.step,
        record.iteration,
        record.timestamp,
        record.persona,
      );
      movement.persona = record.persona;
      movement.instruction = record.instruction;
      continue;
    }

    if (record.type === 'step_complete') {
      const iteration = latestIterationByStep.get(record.step);
      if (iteration == null) {
        throw new Error(`Missing iteration for step_complete: ${record.step}`);
      }
      const movement = ensureMovement(
        movementsByKey,
        record.step,
        iteration,
        record.timestamp,
        record.persona,
      );
      movement.completedAt = record.timestamp;
      movement.result = {
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
      const iteration = record.iteration ?? latestIterationByStep.get(record.step);
      if (iteration == null) {
        throw new Error(`Missing iteration for phase_start: ${record.step}:${record.phase}`);
      }
      const movement = ensureMovement(
        movementsByKey,
        record.step,
        iteration,
        record.timestamp,
        record.step,
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
      movement.phases.push(phase);
      phasesByExecutionId.set(resolvedExecutionId, {
        movement,
        index: movement.phases.length - 1,
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
        ?? latestIterationByStep.get(record.step);
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
      const existing = phaseRef.movement.phases[phaseRef.index];
      if (!existing) {
        throw new Error(`Missing phase state for completion: ${resolvedExecutionId}`);
      }
      const prompt = promptByExecutionId.get(resolvedExecutionId);
      phaseRef.movement.phases[phaseRef.index] = {
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
      const existing = phaseRef.movement.phases[phaseRef.index];
      if (!existing) {
        continue;
      }
      phaseRef.movement.phases[phaseRef.index] = {
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

  const movements = [...movementsByKey.values()].sort((a, b) => {
    const byStart = a.startedAt.localeCompare(b.startedAt);
    if (byStart !== 0) {
      return byStart;
    }
    return a.iteration - b.iteration;
  });

  return {
    traceStartedAt: traceStartedAt || defaultEndTime,
    movements,
  };
}

export type { PromptRecord };
