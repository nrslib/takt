import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { lstat, opendir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod/v4';
import { FileAsyncLock } from './lock.js';
import { ensurePrivateDirectory, hasCode, readEntirePrivateFile, writePrivateFile } from './privateFile.js';

const notification = z.object({ id: z.string().min(1).max(128), message: z.string().min(1), turnOperationId: z.string().min(1).optional(),
  conversationId: z.string().min(1).optional(),
  subject: z.object({ key: z.string().min(1), state: z.string().min(1) }).strict().optional() }).strict();
const storedNotification = notification.extend({ clearOperationId: z.string().min(1).nullable().optional() });
export type DirectorNotification = Pick<z.infer<typeof notification>, 'id' | 'message'>;
export type DirectorNotificationSubject = NonNullable<z.infer<typeof notification>['subject']>;
type Notification = z.infer<typeof storedNotification>;
interface DirectorContextClear { operationId: string; savedAt: bigint }
const key = (value: string): string => createHash('sha256').update(value).digest('hex');
const MANAGER_RESULT_PREFIX = 'result-';
export const managerResultNotificationId = (operationId: string): string => `${MANAGER_RESULT_PREFIX}${operationId}`;
/** 索引に保持する通知の合計サイズの上限。超えた分は保持せず、走査のたびに読み直す。 */
const MAX_CACHED_NOTIFICATION_BYTES = 16 * 1024 * 1024;
const DIRECTOR_CLEAR_BOUNDARY = 'director-clear-boundary';
const fileIdentity = (info: BigIntStats): string =>
  `${info.dev}:${info.ino}:${info.mtimeNs}:${info.ctimeNs}:${info.size}`;

export class DaemonNotifications {
  private readonly directory: string;
  private readonly clearPath: string;
  private readonly lock = new FileAsyncLock();
  /** ディレクトリの stamp が変わらない間は、読み込み済みの通知を使い回す。 */
  private readonly index: { stamp: string | undefined; directoryId: string | undefined; values: Map<string, { value: Notification; bytes: number; identity: string }>; cachedBytes: number; complete: boolean } = { stamp: undefined, directoryId: undefined, values: new Map(), cachedBytes: 0, complete: false };
  /** 走査同士が索引を同時に書き換えないよう、refresh() の実行を直列化するための待ち行列。 */
  private pending = Promise.resolve();
  /** save() が書き込むたびに進む。走査の開始後に進んでいたら、その走査は stamp を記録しない。 */
  private generation = 0;
  constructor(directory: string) {
    this.directory = join(directory, 'director-notifications');
    this.clearPath = join(this.directory, DIRECTOR_CLEAR_BOUNDARY);
  }

  async save(input: z.infer<typeof notification>, signal: AbortSignal): Promise<boolean> {
    const value = notification.parse(input);
    return this.lock.exclusive(join(this.directory, '.lock'), async () => {
      signal.throwIfAborted();
      const name = `${key(value.id)}.json`;
      const path = join(this.directory, name);
      const managerResult = value.id.startsWith(MANAGER_RESULT_PREFIX);
      const serializedInput = JSON.stringify(value);
      const prior = await readEntirePrivateFile(path)
        ?? (z.uuid().safeParse(value.id).success ? await readEntirePrivateFile(join(this.directory, `${value.id}.json`)) : undefined);
      if (prior !== undefined) {
        const existing = prior.toString('utf8');
        if (existing === serializedInput) return false;
        if (managerResult) {
          const { clearOperationId, ...original } = storedNotification.parse(JSON.parse(existing) as unknown);
          // A replay belongs to the clear that was current at first publication.
          if (clearOperationId !== undefined && JSON.stringify(original) === serializedInput) return false;
        }
        throw new Error('Notification ID reused with different content');
      }
      if (value.subject !== undefined) {
        for await (const saved of this.storedNotifications()) {
          if (saved.subject?.key === value.subject.key && saved.subject.state === value.subject.state) return false;
        }
      }
      const record = managerResult ? { ...value, clearOperationId: (await this.readClearOperationId()) ?? null } : value;
      const serialized = JSON.stringify(record);
      await writePrivateFile(path, serialized, signal);
      this.generation += 1;
      this.index.stamp = undefined;
      const identity = await this.fileIdentityOf(path);
      if (identity !== undefined) this.retain(name, record, Buffer.byteLength(serialized), identity);
      return true;
    }, { signal, timeoutMs: 5000 });
  }

  async *iterate(): AsyncGenerator<z.infer<typeof notification>> {
    for await (const stored of this.refresh()) {
      const value = structuredClone(stored);
      delete value.clearOperationId;
      yield value;
    }
  }

  async managerResultPublishedAt(operationId: string, clear: DirectorContextClear | undefined): Promise<bigint | undefined> {
    const id = managerResultNotificationId(operationId);
    const name = `${key(id)}.json`;
    const path = join(this.directory, name);
    const info = await this.savedFileInfo(path);
    if (info === undefined || clear === undefined) return info?.mtimeNs;
    const cached = this.index.values.get(name);
    let value: Notification;
    if (cached?.identity === fileIdentity(info)) value = cached.value;
    else {
      const content = await readEntirePrivateFile(path);
      if (content === undefined) return undefined;
      value = storedNotification.parse(JSON.parse(content.toString('utf8')) as unknown);
    }
    if (value.id !== id) throw new Error('Notification identity mismatch');
    const visible = value.clearOperationId === undefined ? info.mtimeNs > clear.savedAt : value.clearOperationId === clear.operationId;
    return visible ? info.mtimeNs : undefined;
  }

  async recordDirectorContextClear(operationId: string): Promise<void> {
    const signal = new AbortController().signal;
    await this.lock.exclusive(join(this.directory, '.lock'), async () => {
      if (await this.readClearOperationId() === operationId) return;
      // Keep retries at the original boundary so they cannot discard replies published since.
      await writePrivateFile(this.clearPath, operationId, signal);
    }, { signal, timeoutMs: 5000 });
  }

  async directorContextClear(): Promise<DirectorContextClear | undefined> {
    const operationId = await this.readClearOperationId();
    if (operationId === undefined) return undefined;
    const info = await this.savedFileInfo(this.clearPath);
    return info === undefined ? undefined : { operationId, savedAt: info.mtimeNs };
  }

  private async readClearOperationId(): Promise<string | undefined> {
    return (await readEntirePrivateFile(this.clearPath))?.toString('utf8');
  }

  private async savedFileInfo(path: string): Promise<BigIntStats | undefined> {
    const info = await lstat(path, { bigint: true }).catch((error: unknown) => { if (!hasCode(error, 'ENOENT')) throw error; });
    if (info === undefined) return undefined;
    if (!info.isFile()) throw new Error('Invalid director notification store file');
    return info;
  }

  /** 索引と待ち行列を使わず、保存済みの通知をディレクトリから直接読み取る。save() の重複確認専用。 */
  private async *storedNotifications(): AsyncGenerator<Notification> {
    await ensurePrivateDirectory(this.directory);
    for await (const entry of await opendir(this.directory)) {
      if (!entry.name.endsWith('.json')) continue;
      const content = await readEntirePrivateFile(join(this.directory, entry.name));
      if (content === undefined) throw new Error('Notification disappeared during read');
      const value = storedNotification.parse(JSON.parse(content.toString('utf8')) as unknown);
      if (entry.name !== `${key(value.id)}.json` && entry.name !== `${z.uuid().parse(value.id)}.json`) throw new Error('Notification identity mismatch');
      yield value;
    }
  }

  private refresh(): AsyncGenerator<Notification> {
    const previous = this.pending;
    let release!: () => void;
    this.pending = new Promise<void>((resolve) => { release = resolve; });
    return this.serializedScan(previous, release);
  }

  private async *serializedScan(previous: Promise<void>, release: () => void): AsyncGenerator<Notification> {
    await previous;
    try {
      yield* this.scan();
    } finally {
      release();
    }
  }

  private async *scan(): AsyncGenerator<Notification> {
    const generation = this.generation;
    await ensurePrivateDirectory(this.directory);
    const info = await stat(this.directory);
    const stamp = JSON.stringify([info.dev, info.ino, info.mtimeMs]);
    if (stamp === this.index.stamp && this.index.complete) {
      // 保持済みの通知も、走査と同じファイル名順で返す。
      // 返す途中で保存が索引を書き換えても壊れないよう、値そのものを先に確定させる。
      const entries = [...this.index.values.entries()].sort(([left], [right]) => left.localeCompare(right));
      for (const [, entry] of entries) yield entry.value;
      return;
    }
    const directoryId = JSON.stringify([info.dev, info.ino, info.birthtimeMs]);
    if (directoryId !== this.index.directoryId) {
      // ディレクトリが作り直されると、同じ名前のファイルでも中身は別物になるため、読み込み済みの通知は使い回せない。
      // inode が再利用されても作り直しを検出できるよう、識別子には作成時刻も含める。
      this.index.values.clear();
      this.index.cachedBytes = 0;
      this.index.directoryId = directoryId;
    }
    const names: string[] = [];
    for await (const entry of await opendir(this.directory)) {
      if (entry.name.endsWith('.json')) names.push(entry.name);
    }
    // ファイル名順に読み取ることで、列挙順や索引の挿入順に並びが左右されなくなる。
    names.sort((left, right) => left.localeCompare(right));
    let complete = true;
    for (const name of names) {
      const path = join(this.directory, name);
      const identity = await this.fileIdentityOf(path);
      const cached = this.index.values.get(name);
      if (cached !== undefined && identity !== undefined && identity === cached.identity) {
        yield cached.value;
        continue;
      }
      const content = await readEntirePrivateFile(path);
      if (content === undefined) throw new Error('Notification disappeared during read');
      const value = storedNotification.parse(JSON.parse(content.toString('utf8')) as unknown);
      if (name !== `${key(value.id)}.json` && name !== `${z.uuid().parse(value.id)}.json`) throw new Error('Notification identity mismatch');
      // 走査の開始後に保存が完了していたら、保存した値は索引へ反映済みのため、読み取り中の内容で上書きしない。
      // ファイルの同一性を確認できなかった場合も、保持せずに次の走査で読み直す。
      if (identity === undefined || generation !== this.generation || !this.retain(name, value, content.length, identity)) complete = false;
      yield value;
    }
    const enumerated = new Set(names);
    for (const [name, cached] of this.index.values) {
      if (!enumerated.has(name)) {
        this.index.cachedBytes -= cached.bytes;
        this.index.values.delete(name);
      }
    }
    if (generation === this.generation) {
      this.index.stamp = stamp;
      this.index.complete = complete;
    } else {
      this.index.complete = false;
    }
  }

  /** ファイルの同一性を返す。取得できなかった場合は undefined を返す。 */
  private async fileIdentityOf(path: string): Promise<string | undefined> {
    try {
      return fileIdentity(await stat(path, { bigint: true }));
    } catch {
      return undefined;
    }
  }

  /** 保持済みの合計サイズが上限を超える場合は保持せず、保持できたら true を返す。 */
  private retain(name: string, value: Notification, bytes: number, identity: string): boolean {
    const existing = this.index.values.get(name);
    if (existing !== undefined) {
      this.index.cachedBytes -= existing.bytes;
      this.index.values.delete(name);
    }
    if (this.index.cachedBytes + bytes > MAX_CACHED_NOTIFICATION_BYTES) return false;
    this.index.values.set(name, { value, bytes, identity });
    this.index.cachedBytes += bytes;
    return true;
  }
}
