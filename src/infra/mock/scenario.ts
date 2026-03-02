/**
 * Mock scenario support for integration testing.
 *
 * Provides a queue-based mechanism to control mock provider responses
 * per agent or by call order. Scenarios can be loaded from JSON files
 * (via TAKT_MOCK_SCENARIO env var) or set programmatically in tests.
 */

import { readFileSync, existsSync } from 'node:fs';
import type { ScenarioEntry } from './types.js';

export type { ScenarioEntry };

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
  const validStatuses = ['done', 'blocked', 'error', 'approved', 'rejected', 'improve'] as const;
  const status = obj.status ?? 'done';
  if (typeof status !== 'string' || !validStatuses.includes(status as typeof validStatuses[number])) {
    throw new Error(
      `Scenario entry [${index}] has invalid status "${String(status)}". Valid: ${validStatuses.join(', ')}`,
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

  return {
    persona: obj.persona as string | undefined,
    status: status as ScenarioEntry['status'],
    content: obj.content as string,
    structuredOutput: obj.structured_output as Record<string, unknown> | undefined,
  };
}
