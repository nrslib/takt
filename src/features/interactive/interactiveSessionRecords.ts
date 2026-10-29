import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getProjectConfigDir } from '../../infra/config/paths.js';
import { writeFileAtomic } from '../../infra/config/project/sessionStore.js';
import { warn } from '../../shared/ui/index.js';

export interface InteractiveSessionRecord {
  provider: string;
  sessionId: string;
  inputs: string[];
  response: string;
  modified: string;
  messageCount: number;
}

type CheckSession = (provider: string, sessionId: string) => Promise<boolean | undefined>;

export function getRecordsPath(cwd: string): string {
  return join(getProjectConfigDir(cwd), 'interactive-sessions.json');
}

function readRecords(cwd: string): InteractiveSessionRecord[] {
  const path = getRecordsPath(cwd);
  if (!existsSync(path)) return [];
  const data: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(data) || !data.every((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null) return false;
    const record = entry as Partial<InteractiveSessionRecord>;
    return typeof record.provider === 'string' && typeof record.sessionId === 'string'
      && Array.isArray(record.inputs) && record.inputs.every((input: unknown) => typeof input === 'string')
      && typeof record.response === 'string' && typeof record.modified === 'string'
      && typeof record.messageCount === 'number';
  })) throw new Error('Invalid interactive session records');
  return data as InteractiveSessionRecord[];
}

function writeRecords(cwd: string, records: InteractiveSessionRecord[]): void {
  mkdirSync(getProjectConfigDir(cwd), { recursive: true });
  writeFileAtomic(getRecordsPath(cwd), JSON.stringify(records), 0o600);
}

type Turn = { cwd: string; provider: string; sessionId: string; input: string; response: string };
type SessionKey = Pick<Turn, 'provider' | 'sessionId'>;
type Input = SessionKey & { input: string };
type Response = SessionKey & { inputRevision: number; response: string };

function sessionKey(record: SessionKey): string {
  return JSON.stringify([record.provider, record.sessionId]);
}

function appendInput(records: InteractiveSessionRecord[], args: Input): { records: InteractiveSessionRecord[]; revision: number } {
  const previous = records.find((record) => record.provider === args.provider && record.sessionId === args.sessionId);
  const next: InteractiveSessionRecord = {
    provider: args.provider,
    sessionId: args.sessionId,
    inputs: [...(previous?.inputs ?? []), args.input].slice(-3),
    response: previous?.response ?? '',
    modified: new Date().toISOString(),
    messageCount: (previous?.messageCount ?? 0) + 1,
  };
  return { records: [next, ...records.filter((record) => record !== previous)], revision: next.messageCount };
}

function updateResponse(records: InteractiveSessionRecord[], args: Response): InteractiveSessionRecord[] | undefined {
  const previous = records.find((record) => record.provider === args.provider && record.sessionId === args.sessionId);
  if (previous?.messageCount !== args.inputRevision) return undefined;
  const next = { ...previous, response: args.response, messageCount: previous.messageCount + 1 };
  return records.map((record) => record === previous ? next : record);
}

function updateRecords(records: InteractiveSessionRecord[], args: Turn): InteractiveSessionRecord[] {
  const input = appendInput(records, args);
  const updated = updateResponse(input.records, {
    provider: args.provider,
    sessionId: args.sessionId,
    inputRevision: input.revision,
    response: args.response,
  });
  if (updated === undefined) throw new Error('Interactive session response was not recorded');
  return updated;
}

export function recordTurn(args: Turn): void {
  writeRecords(args.cwd, updateRecords(readRecords(args.cwd), args));
}

export function listRecords(cwd: string, provider: string): InteractiveSessionRecord[] {
  return readRecords(cwd).filter((record) => record.provider === provider).slice(0, 10);
}

async function cleanAndReadRecords(cwd: string, exists: CheckSession): Promise<InteractiveSessionRecord[]> {
  if (!existsSync(getRecordsPath(cwd))) return [];
  let records: InteractiveSessionRecord[];
  try {
    records = readRecords(cwd);
  } catch {
    writeRecords(cwd, []);
    return [];
  }

  const counts = new Map<string, number>();
  const missing = new Map<string, string>();
  for (const record of records) {
    const count = counts.get(record.provider) ?? 0;
    if (count >= 10) continue;
    let existsResult: boolean | undefined;
    try {
      existsResult = await exists(record.provider, record.sessionId);
    } catch {
      existsResult = undefined;
    }
    if (existsResult === false) {
      missing.set(sessionKey(record), JSON.stringify(record));
      continue;
    }
    counts.set(record.provider, count + 1);
  }
  let latest: InteractiveSessionRecord[];
  try {
    latest = readRecords(cwd);
  } catch {
    writeRecords(cwd, []);
    return [];
  }
  const retainedCounts = new Map<string, number>();
  const retained = latest.filter((record) => {
    if (missing.get(sessionKey(record)) === JSON.stringify(record)) return false;
    const count = retainedCounts.get(record.provider) ?? 0;
    if (count >= 10) return false;
    retainedCounts.set(record.provider, count + 1);
    return true;
  });
  writeRecords(cwd, retained);
  return retained;
}

export async function cleanRecords(cwd: string, exists: CheckSession): Promise<void> {
  await cleanAndReadRecords(cwd, exists);
}

/** Owns records for the lifetime of a single interactive run. */
export class InteractiveSessionRecords {
  private pending: InteractiveSessionRecord[] | undefined;
  private snapshot: InteractiveSessionRecord[] = [];
  private readFailed = false;
  private discarded = new Set<string>();

  constructor(private readonly cwd: string) {}

  async clean(exists: CheckSession): Promise<void> {
    try {
      this.snapshot = await cleanAndReadRecords(this.cwd, exists);
    } catch (error) {
      this.pending = [];
      warn(`Interactive session records could not be saved: ${String(error)}`);
    }
  }

  list(provider: string): InteractiveSessionRecord[] {
    if (this.pending === undefined) {
      try {
        this.snapshot = readRecords(this.cwd);
      } catch (error) {
        this.readFailed = true;
        this.pending = this.snapshot;
        warn(`Interactive session records could not be read: ${String(error)}`);
      }
    }
    return (this.pending ?? this.snapshot).filter((record) => record.provider === provider).slice(0, 10);
  }

  private update<T>(change: (records: InteractiveSessionRecord[]) => { records: InteractiveSessionRecord[]; value: T } | undefined): T | undefined {
    if (this.pending === undefined) {
      try {
        this.snapshot = readRecords(this.cwd);
      } catch (error) {
        this.readFailed = true;
        warn(`Interactive session records could not be read: ${String(error)}`);
      }
      this.pending = this.snapshot;
    }
    if (this.readFailed) {
      try {
        const saved = readRecords(this.cwd);
        this.pending = [...this.pending, ...saved.filter((record) => !this.discarded.has(sessionKey(record))
          && !this.pending!.some((current) => current.provider === record.provider && current.sessionId === record.sessionId))];
        this.readFailed = false;
      } catch {
        const changed = change(this.pending);
        if (changed === undefined) return undefined;
        this.pending = changed.records;
        this.snapshot = this.pending;
        return changed.value;
      }
    }
    const changed = change(this.pending);
    if (changed === undefined) return undefined;
    this.pending = changed.records;
    this.snapshot = this.pending;
    try {
      writeRecords(this.cwd, this.pending);
      this.pending = undefined;
      this.discarded.clear();
    } catch (error) {
      warn(`Interactive session records could not be saved: ${String(error)}`);
    }
    return changed.value;
  }

  recordInput(args: Input): number {
    const revision = this.update((records) => {
      const changed = appendInput(records, args);
      return { records: changed.records, value: changed.revision };
    });
    if (revision === undefined) throw new Error('Interactive session input was not recorded');
    return revision;
  }

  recordResponse(args: Response): void {
    this.update((records) => {
      const changed = updateResponse(records, args);
      return changed === undefined ? undefined : { records: changed, value: undefined };
    });
  }

  discard(args: SessionKey): void {
    this.discarded.add(sessionKey(args));
    this.update((records) => ({
      records: records.filter((record) => record.provider !== args.provider || record.sessionId !== args.sessionId),
      value: undefined,
    }));
  }
}
