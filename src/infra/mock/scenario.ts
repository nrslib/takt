/**
 * Mock scenario support for integration testing.
 *
 * Provides a queue-based mechanism to control mock provider responses
 * per agent or by call order. Scenarios can be loaded from JSON files
 * (via TAKT_MOCK_SCENARIO env var) or set programmatically in tests.
 */

import { readFileSync, existsSync } from 'node:fs';
import type { ScenarioEntry } from './types.js';
import { STATUS_VALUES } from '../../core/models/status.js';
import { AGENT_FAILURE_CATEGORIES } from '../../shared/types/agent-failure.js';

export type { ScenarioEntry };

const AGENT_FAILURE_CATEGORY_VALUES = new Set<string>(Object.values(AGENT_FAILURE_CATEGORIES));

/**
 * Queue that dispenses scenario entries.
 *
 * Matching rules:
 * 1. If an entry has `agent` set, it only matches calls for that agent name.
 * 2. Entries without `agent` match any call (consumed in order).
 * 3. First matching entry is removed from the queue and returned.
 * 4. Returns undefined when no matching entry remains.
 */
export class ScenarioQueue {
  private entries: ScenarioEntry[];

  constructor(entries: ScenarioEntry[]) {
    // Defensive copy
    this.entries = [...entries];
  }

  /**
   * Consume the next matching entry for the given agent.
   */
  consume(personaName: string): ScenarioEntry | undefined {
    // Try persona-specific match first
    const personaIndex = this.entries.findIndex(
      (e) => e.persona !== undefined && e.persona === personaName,
    );
    if (personaIndex >= 0) {
      return this.entries.splice(personaIndex, 1)[0];
    }

    // Fall back to first unspecified entry
    const anyIndex = this.entries.findIndex((e) => e.persona === undefined);
    if (anyIndex >= 0) {
      return this.entries.splice(anyIndex, 1)[0];
    }

    return undefined;
  }

  /** Number of remaining entries */
  get remaining(): number {
    return this.entries.length;
  }
}

// --- Global singleton (module-level state) ---

let globalQueue: ScenarioQueue | null = null;

/**
 * Set mock scenario programmatically (for tests).
 * Pass null to clear.
 */
export function setMockScenario(entries: ScenarioEntry[] | null): void {
  globalQueue = entries ? new ScenarioQueue(entries) : null;
}

/**
 * Get the current global scenario queue.
 * Lazily loads from TAKT_MOCK_SCENARIO env var on first access.
 */
export function getScenarioQueue(): ScenarioQueue | null {
  if (globalQueue) return globalQueue;

  const envPath = process.env.TAKT_MOCK_SCENARIO;
  if (envPath) {
    const entries = loadScenarioFile(envPath);
    globalQueue = new ScenarioQueue(entries);
    return globalQueue;
  }

  return null;
}

/**
 * Reset global scenario state (for test cleanup).
 */
export function resetScenario(): void {
  globalQueue = null;
}

/**
 * Load and validate a scenario JSON file.
 *
 * @param filePath Absolute or relative path to scenario JSON
 * @throws Error if file not found or JSON invalid
 */
export function loadScenarioFile(filePath: string): ScenarioEntry[] {
  if (!existsSync(filePath)) {
    throw new Error(`Scenario file not found: ${filePath}`);
  }

  const raw = readFileSync(filePath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Scenario file is not valid JSON: ${filePath}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`Scenario file must contain a JSON array: ${filePath}`);
  }

  return parsed.map((entry, i) => validateEntry(entry, i));
}

function validateEntry(entry: unknown, index: number): ScenarioEntry {
  if (typeof entry !== 'object' || entry === null) {
    throw new Error(`Scenario entry [${index}] must be an object`);
  }

  const obj = entry as Record<string, unknown>;

  // content is required
  if (typeof obj.content !== 'string') {
    throw new Error(`Scenario entry [${index}] must have a "content" string`);
  }

  // status defaults to 'done'
  const status = obj.status ?? 'done';
  if (typeof status !== 'string' || !STATUS_VALUES.includes(status as typeof STATUS_VALUES[number])) {
    throw new Error(
      `Scenario entry [${index}] has invalid status "${String(status)}". Valid: ${STATUS_VALUES.join(', ')}`,
    );
  }

  // persona is optional
  if (obj.persona !== undefined && typeof obj.persona !== 'string') {
    throw new Error(`Scenario entry [${index}] "persona" must be a string if provided`);
  }

  // structured_output is optional
  if (obj.structured_output !== undefined && (typeof obj.structured_output !== 'object' || obj.structured_output === null || Array.isArray(obj.structured_output))) {
    throw new Error(`Scenario entry [${index}] "structured_output" must be an object if provided`);
  }
  // delay_ms is optional
  if (obj.delay_ms !== undefined && typeof obj.delay_ms !== 'number') {
    throw new Error(`Scenario entry [${index}] "delay_ms" must be a number if provided`);
  }
  if (obj.wait_for_abort !== undefined && typeof obj.wait_for_abort !== 'boolean') {
    throw new Error(`Scenario entry [${index}] "wait_for_abort" must be a boolean if provided`);
  }
  if (obj.error !== undefined && typeof obj.error !== 'string') {
    throw new Error(`Scenario entry [${index}] "error" must be a string if provided`);
  }
  if (
    obj.failure_category !== undefined
    && (typeof obj.failure_category !== 'string' || !AGENT_FAILURE_CATEGORY_VALUES.has(obj.failure_category))
  ) {
    throw new Error(`Scenario entry [${index}] "failure_category" is invalid`);
  }
  const streamEvents = validateStreamEvents(obj.stream_events, index);
  const textChunks = validateTextChunks(obj.text_chunks, index);
  const fileWrites = validateFileWrites(obj.file_writes, index);

  return {
    persona: obj.persona as string | undefined,
    status: status as ScenarioEntry['status'],
    content: obj.content as string,
    structuredOutput: obj.structured_output as Record<string, unknown> | undefined,
    error: obj.error as string | undefined,
    failureCategory: obj.failure_category as ScenarioEntry['failureCategory'],
    delayMs: obj.delay_ms as number | undefined,
    waitForAbort: obj.wait_for_abort as boolean | undefined,
    ...(streamEvents === undefined ? {} : { streamEvents }),
    ...(textChunks === undefined ? {} : { textChunks }),
    ...(fileWrites === undefined ? {} : { fileWrites }),
  };
}

function validateStreamEvents(
  value: unknown,
  entryIndex: number,
): ScenarioEntry['streamEvents'] {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`Scenario entry [${entryIndex}] "stream_events" must be an array`);
  }
  return value.map((event, eventIndex) => {
    if (typeof event !== 'object' || event === null || Array.isArray(event)) {
      throw new Error(`Scenario entry [${entryIndex}] stream_events[${eventIndex}] must be an object`);
    }
    const record = event as Record<string, unknown>;
    if (
      record.type !== 'tool_use'
      || typeof record.tool !== 'string'
      || typeof record.id !== 'string'
      || typeof record.input !== 'object'
      || record.input === null
      || Array.isArray(record.input)
    ) {
      throw new Error(`Scenario entry [${entryIndex}] stream_events[${eventIndex}] is invalid`);
    }
    return {
      type: 'tool_use' as const,
      tool: record.tool,
      id: record.id,
      input: record.input as Record<string, unknown>,
    };
  });
}

function validateTextChunks(
  value: unknown,
  entryIndex: number,
): ScenarioEntry['textChunks'] {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`Scenario entry [${entryIndex}] "text_chunks" must be an array`);
  }
  return value.map((chunk, chunkIndex) => {
    if (typeof chunk !== 'object' || chunk === null || Array.isArray(chunk)) {
      throw new Error(`Scenario entry [${entryIndex}] text_chunks[${chunkIndex}] must be an object`);
    }
    const record = chunk as Record<string, unknown>;
    if (typeof record.text !== 'string') {
      throw new Error(`Scenario entry [${entryIndex}] text_chunks[${chunkIndex}] must have a "text" string`);
    }
    const delayMs = record.delay_ms;
    if (delayMs !== undefined && typeof delayMs !== 'number') {
      throw new Error(`Scenario entry [${entryIndex}] text_chunks[${chunkIndex}] "delay_ms" must be a number if provided`);
    }
    return {
      text: record.text,
      ...(delayMs === undefined ? {} : { delayMs }),
    };
  });
}

function validateFileWrites(
  value: unknown,
  entryIndex: number,
): ScenarioEntry['fileWrites'] {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`Scenario entry [${entryIndex}] "file_writes" must be an array`);
  }
  return value.map((write, writeIndex) => {
    if (typeof write !== 'object' || write === null || Array.isArray(write)) {
      throw new Error(`Scenario entry [${entryIndex}] file_writes[${writeIndex}] must be an object`);
    }
    const record = write as Record<string, unknown>;
    if (
      typeof record.path !== 'string'
      || record.path.length === 0
      || typeof record.content !== 'string'
    ) {
      throw new Error(`Scenario entry [${entryIndex}] file_writes[${writeIndex}] is invalid`);
    }
    return { path: record.path, content: record.content };
  });
}
