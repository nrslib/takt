import { createReadStream, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { resolveCodexHomeDirectory } from './home.js';

export interface CodexRolloutObservation {
  readonly sessionsRoot: string;
  readonly startedAt: Date;
  readonly initialSessionId: string | undefined;
  readonly rolloutPath: string | undefined;
  readonly byteOffset: number;
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function isRolloutForSession(name: string, sessionId: string): boolean {
  return name.startsWith('rollout-') && name.endsWith(`-${sessionId}.jsonl`);
}

function findRolloutInDirectory(
  directory: string,
  sessionId: string,
): string | undefined {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  const entry = entries.find((candidate) => (
    candidate.isFile() && isRolloutForSession(candidate.name, sessionId)
  ));
  return entry === undefined ? undefined : join(directory, entry.name);
}

function findRolloutRecursively(
  directory: string,
  sessionId: string,
): string | undefined {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const match = findRolloutRecursively(path, sessionId);
      if (match !== undefined) return match;
    } else if (entry.isFile() && isRolloutForSession(entry.name, sessionId)) {
      return path;
    }
  }
  return undefined;
}

function dateDirectoryParts(date: Date): string[] {
  return [
    String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ];
}

function findInitialRollout(
  sessionsRoot: string,
  startedAt: Date,
  sessionId: string,
): string | undefined {
  const dates = [startedAt, new Date()];
  for (const date of dates) {
    const directory = join(sessionsRoot, ...dateDirectoryParts(date));
    const match = findRolloutInDirectory(directory, sessionId);
    if (match !== undefined) return match;
  }
  return undefined;
}

export function createCodexRolloutObservation(
  environment: Record<string, string>,
  sessionId: string | undefined,
  startedAt: Date,
): CodexRolloutObservation {
  const sessionsRoot = join(resolveCodexHomeDirectory(environment), 'sessions');
  let rolloutPath: string | undefined;
  let byteOffset = 0;
  if (sessionId !== undefined) {
    try {
      rolloutPath = findRolloutRecursively(sessionsRoot, sessionId);
      if (rolloutPath !== undefined) {
        byteOffset = statSync(rolloutPath).size;
      }
    } catch {
      // Rollout observation is optional; an unreadable or removed rollout must not abort the Codex turn.
      rolloutPath = undefined;
      byteOffset = 0;
    }
  }
  return {
    sessionsRoot,
    startedAt,
    initialSessionId: sessionId,
    rolloutPath,
    byteOffset,
  };
}

async function containsCompaction(
  rolloutPath: string,
  byteOffset: number,
): Promise<boolean> {
  const input = createReadStream(rolloutPath, { start: byteOffset });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (line.length === 0) continue;
      const record = JSON.parse(line) as { type?: unknown };
      if (record.type === 'compacted') return true;
    }
    return false;
  } finally {
    lines.close();
    input.destroy();
  }
}

export async function detectCodexCompaction(
  observation: CodexRolloutObservation,
  sessionId: string | undefined,
): Promise<boolean> {
  try {
    if (sessionId === undefined) return false;
    if (observation.initialSessionId === sessionId) {
      return observation.rolloutPath !== undefined
        && await containsCompaction(observation.rolloutPath, observation.byteOffset);
    }

    const rolloutPath = findInitialRollout(
      observation.sessionsRoot,
      observation.startedAt,
      sessionId,
    );
    return rolloutPath !== undefined && await containsCompaction(rolloutPath, 0);
  } catch {
    // An unreadable or incomplete rollout disables optional detection; it does not fail the completed turn.
    return false;
  }
}
