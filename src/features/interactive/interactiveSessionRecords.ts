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

function updateRecords(records: InteractiveSessionRecord[], args: Turn): InteractiveSessionRecord[] {
  const previous = records.find((record) => record.provider === args.provider && record.sessionId === args.sessionId);
  const next: InteractiveSessionRecord = {
    provider: args.provider,
    sessionId: args.sessionId,
    inputs: [...(previous?.inputs ?? []), args.input].slice(-3),
    response: args.response,
    modified: new Date().toISOString(),
    messageCount: (previous?.messageCount ?? 0) + 2,
  };
  return [next, ...records.filter((record) => record !== previous)];
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
  const retained: InteractiveSessionRecord[] = [];
  for (const record of records) {
    const count = counts.get(record.provider) ?? 0;
    if (count >= 10) continue;
    let existsResult: boolean | undefined;
    try {
      existsResult = await exists(record.provider, record.sessionId);
    } catch {
      existsResult = undefined;
    }
    if (existsResult === false) continue;
    counts.set(record.provider, count + 1);
    retained.push(record);
  }
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

  record(args: Omit<Turn, 'cwd'>): void {
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
        this.pending = [...this.pending, ...saved.filter((record) => !this.pending!.some(
          (current) => current.provider === record.provider && current.sessionId === record.sessionId,
        ))];
        this.readFailed = false;
      } catch {
        this.pending = updateRecords(this.pending, { cwd: this.cwd, ...args });
        this.snapshot = this.pending;
        return;
      }
    }
    this.pending = updateRecords(this.pending, { cwd: this.cwd, ...args });
    this.snapshot = this.pending;
    try {
      writeRecords(this.cwd, this.pending);
      this.pending = undefined;
    } catch (error) {
      warn(`Interactive session records could not be saved: ${String(error)}`);
    }
  }
}
