import { lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runPrivateFileExclusiveAsync } from '../../shared/utils/private-file-lock.js';
import { appendPrivateFile, readPrivateFileState } from '../../shared/utils/private-file.js';
import { buildLiveInterventionPrompt } from '../../core/workflow/live-intervention/prompt.js';
import {
  createLiveInterventionState,
  reduceLiveInterventionEvent,
  type LiveInterventionEvent,
} from '../../core/workflow/live-intervention/state.js';
import type {
  LiveInterventionChannel,
  LiveInterventionDeliveryContext,
  LiveInterventionDeliveryMode,
  LiveInterventionState,
  PreparedLiveInterventionDelivery,
} from '../../core/workflow/live-intervention/types.js';

function assertSafeRunSlug(runSlug: string): void {
  if (!runSlug || runSlug === '.' || runSlug === '..' || /[\\/]/u.test(runSlug)) {
    throw new Error(`Invalid run slug: ${runSlug}`);
  }
}

function parseString(value: unknown, name: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${name} must be a string`);
  }
  return value;
}

function parseNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number`);
  }
  return value;
}

function parseNumberArray(value: unknown, name: string): number[] {
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be an array`);
  }
  return value.map((entry, index) => parseNumber(entry, `${name}[${index}]`));
}

function parseOptionalNumber(value: unknown, name: string): number | undefined {
  return value === undefined ? undefined : parseNumber(value, name);
}

function parseOptionalNumberArray(value: unknown, name: string): number[] | undefined {
  return value === undefined ? undefined : parseNumberArray(value, name);
}

function parseDeliveryMode(value: unknown): LiveInterventionDeliveryMode {
  if (value !== 'same_session' && value !== 'next_step' && value !== 'batch_boundary') {
    throw new Error('delivery mode is invalid');
  }
  return value;
}

function parsePhase(value: unknown): 1 | 2 | 3 {
  if (value !== 1 && value !== 2 && value !== 3) {
    throw new Error('phase must be 1, 2, or 3');
  }
  return value;
}

function parseTerminalStatus(value: unknown): 'completed' | 'failed' {
  if (value !== 'completed' && value !== 'failed') {
    throw new Error('Terminal status is invalid');
  }
  return value;
}

function parseEvent(value: unknown): LiveInterventionEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Live intervention event must be an object');
  }
  const event = value as Record<string, unknown>;
  if (event.type === 'issued') {
    return {
      type: 'issued',
      instructionId: parseNumber(event.instructionId, 'instructionId'),
      issuedAt: parseString(event.issuedAt, 'issuedAt'),
      content: parseString(event.content, 'content'),
    };
  }
  if (event.type === 'delivered') {
    return {
      type: 'delivered',
      instructionIds: parseNumberArray(event.instructionIds, 'instructionIds'),
      deliveredAt: parseString(event.deliveredAt, 'deliveredAt'),
      mode: parseDeliveryMode(event.mode),
      step: parseString(event.step, 'step'),
      phase: parsePhase(event.phase),
      ...(event.target === undefined ? {} : { target: parseString(event.target, 'target') }),
      ...(event.processedBatchCount === undefined
        ? {}
        : { processedBatchCount: parseOptionalNumber(event.processedBatchCount, 'processedBatchCount') }),
      ...(event.runningBatchIndexes === undefined
        ? {}
        : { runningBatchIndexes: parseOptionalNumberArray(event.runningBatchIndexes, 'runningBatchIndexes') }),
      ...(event.appliesToBatchIndexes === undefined
        ? {}
        : { appliesToBatchIndexes: parseOptionalNumberArray(event.appliesToBatchIndexes, 'appliesToBatchIndexes') }),
    };
  }
  if (event.type === 'terminal') {
    return {
      type: 'terminal',
      terminalAt: parseString(event.terminalAt, 'terminalAt'),
      status: parseTerminalStatus(event.status),
      unconsumedInstructionIds: parseNumberArray(event.unconsumedInstructionIds, 'unconsumedInstructionIds'),
    };
  }
  throw new Error('Unknown live intervention event type');
}

function parseEvents(raw: string): LiveInterventionEvent[] {
  const events: LiveInterventionEvent[] = [];
  for (const [index, line] of raw.split('\n').entries()) {
    if (line.trim() === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch (error) {
      throw new Error(`Invalid live intervention JSON at line ${index + 1}`, { cause: error });
    }
    events.push(parseEvent(value));
  }
  return events;
}

function reduceEvents(raw: string): LiveInterventionState {
  return parseEvents(raw).reduce(
    (state, event) => reduceLiveInterventionEvent(state, event),
    createLiveInterventionState(),
  );
}

export class LiveInterventionFileStore implements LiveInterventionChannel {
  private readonly runDirectory: string;
  private readonly filePath: string;
  private readonly lockPath: string;

  constructor(projectCwd: string, runSlug: string) {
    assertSafeRunSlug(runSlug);
    this.runDirectory = join(projectCwd, '.takt', 'runs', runSlug);
    this.filePath = join(this.runDirectory, 'interventions.jsonl');
    this.lockPath = `${this.filePath}.lock`;
  }

  getFilePath(): string {
    return this.filePath;
  }

  read(): LiveInterventionState {
    if (!this.hasExistingRunDirectory()) {
      return createLiveInterventionState();
    }
    const snapshot = readPrivateFileState(this.filePath);
    if (!('content' in snapshot)) {
      return createLiveInterventionState();
    }
    return reduceEvents(snapshot.content.toString('utf8'));
  }

  async issue(
    content: string,
    issuedAt = new Date().toISOString(),
    beforeAppend?: () => void,
  ): Promise<number> {
    if (typeof content !== 'string') {
      throw new Error('Live intervention content must be a string');
    }
    return runPrivateFileExclusiveAsync(this.lockPath, () => {
      const state = this.read();
      if (state.terminalStatus !== undefined) {
        throw new Error('Cannot issue a live intervention after terminal state');
      }
      beforeAppend?.();
      const instructionId = state.issuedTotal + 1;
      const event: LiveInterventionEvent = {
        type: 'issued',
        instructionId,
        issuedAt,
        content,
      };
      reduceLiveInterventionEvent(state, event);
      this.append(event);
      return instructionId;
    });
  }

  async prepareDelivery(
    context: LiveInterventionDeliveryContext,
  ): Promise<PreparedLiveInterventionDelivery> {
    const { language, ...deliveryContext } = context;
    const state = this.read();
    const pending = state.instructions.filter((instruction) => instruction.state === 'pending');
    if (pending.length === 0) {
      throw new Error('No pending live intervention instructions');
    }
    return {
      instructionIds: pending.map((instruction) => instruction.instructionId),
      prompt: buildLiveInterventionPrompt(state.instructions, language),
      context: {
        ...deliveryContext,
        ...(context.runningBatchIndexes === undefined
          ? {}
          : { runningBatchIndexes: [...context.runningBatchIndexes] }),
        ...(context.appliesToBatchIndexes === undefined
          ? {}
          : { appliesToBatchIndexes: [...context.appliesToBatchIndexes] }),
      },
    };
  }

  async commitDelivery(delivery: PreparedLiveInterventionDelivery): Promise<void> {
    await runPrivateFileExclusiveAsync(this.lockPath, () => {
      const state = this.read();
      const event: LiveInterventionEvent = {
        type: 'delivered',
        instructionIds: [...delivery.instructionIds],
        deliveredAt: new Date().toISOString(),
        ...delivery.context,
      };
      reduceLiveInterventionEvent(state, event);
      this.append(event);
    });
  }

  async recordTerminal(status: 'completed' | 'failed', terminalAt = new Date().toISOString()): Promise<number> {
    return runPrivateFileExclusiveAsync(this.lockPath, () => {
      const state = this.read();
      if (state.terminalStatus !== undefined) {
        return 0;
      }
      const unconsumedInstructionIds = state.instructions
        .filter((instruction) => instruction.state === 'pending')
        .map((instruction) => instruction.instructionId);
      const event: LiveInterventionEvent = {
        type: 'terminal',
        terminalAt,
        status,
        unconsumedInstructionIds,
      };
      reduceLiveInterventionEvent(state, event);
      this.append(event);
      return unconsumedInstructionIds.length;
    });
  }

  private append(event: LiveInterventionEvent): void {
    appendPrivateFile(this.filePath, `${JSON.stringify(event)}\n`);
  }

  private hasExistingRunDirectory(): boolean {
    const directories = [dirname(dirname(this.runDirectory)), dirname(this.runDirectory), this.runDirectory];
    for (const directory of directories) {
      let stat;
      try {
        stat = lstatSync(directory);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') {
          return false;
        }
        throw error;
      }
      if (stat.isSymbolicLink()) {
        throw new Error(`Private artifact path contains a symlink: ${directory}`);
      }
      if (!stat.isDirectory()) {
        throw new Error(`Private artifact ancestor is unsafe: ${directory}`);
      }
    }
    return true;
  }
}
