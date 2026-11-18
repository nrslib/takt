import { createHash } from 'node:crypto';
import { opendir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod/v4';
import { FileAsyncLock } from './lock.js';
import { ensurePrivateDirectory, readEntirePrivateFile, writePrivateFile } from './privateFile.js';

const notification = z.object({ id: z.string().min(1).max(128), message: z.string().min(1), turnOperationId: z.string().min(1).optional(),
  conversationId: z.string().min(1).optional(),
  subject: z.object({ key: z.string().min(1), state: z.string().min(1) }).strict().optional() }).strict();
export type DirectorNotification = Pick<z.infer<typeof notification>, 'id' | 'message'>;
export type DirectorNotificationSubject = NonNullable<z.infer<typeof notification>['subject']>;
type Notification = z.infer<typeof notification>;
const key = (value: string): string => createHash('sha256').update(value).digest('hex');
/** 索引に保持する通知の合計サイズの上限。超えた分は保持せず、走査のたびに読み直す。 */
const MAX_CACHED_NOTIFICATION_BYTES = 16 * 1024 * 1024;

export class DaemonNotifications {
  private readonly directory: string;
  private readonly lock = new FileAsyncLock();
  /** ディレクトリの stamp が変わらない間は、読み込み済みの通知を使い回す。 */
  private readonly index: { stamp: string | undefined; directoryId: string | undefined; values: Map<string, { value: Notification; bytes: number }>; cachedBytes: number; complete: boolean } = { stamp: undefined, directoryId: undefined, values: new Map(), cachedBytes: 0, complete: false };
  /** 走査同士が索引を同時に書き換えないよう、refresh() の実行を直列化するための待ち行列。 */
  private pending = Promise.resolve();
  /** save() が書き込むたびに進む。走査の開始後に進んでいたら、その走査は stamp を記録しない。 */
  private generation = 0;
  constructor(directory: string) { this.directory = join(directory, 'director-notifications'); }

  async save(input: z.infer<typeof notification>, signal: AbortSignal): Promise<boolean> {
    const value = notification.parse(input);
    return this.lock.exclusive(join(this.directory, '.lock'), async () => {
      signal.throwIfAborted();
      const name = `${key(value.id)}.json`;
      const path = join(this.directory, name);
      const prior = await readEntirePrivateFile(path)
        ?? (z.uuid().safeParse(value.id).success ? await readEntirePrivateFile(join(this.directory, `${value.id}.json`)) : undefined);
      if (prior !== undefined) {
        if (prior.toString('utf8') !== JSON.stringify(value)) throw new Error('Notification ID reused with different content');
        return false;
      }
      if (value.subject !== undefined) {
        for await (const saved of this.iterate()) {
          if (saved.subject?.key === value.subject.key && saved.subject.state === value.subject.state) return false;
        }
      }
      const serialized = JSON.stringify(value);
      await writePrivateFile(path, serialized, signal);
      this.generation += 1;
      this.index.stamp = undefined;
      this.retain(name, value, Buffer.byteLength(serialized));
      return true;
    }, { signal, timeoutMs: 5000 });
  }

  async *iterate(): AsyncGenerator<Notification> {
    for (const value of await this.refresh()) yield structuredClone(value);
  }

  private refresh(): Promise<Notification[]> {
    const operation = this.pending.then(() => this.scan());
    this.pending = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async scan(): Promise<Notification[]> {
    const generation = this.generation;
    await ensurePrivateDirectory(this.directory);
    const info = await stat(this.directory);
    const stamp = JSON.stringify([info.dev, info.ino, info.mtimeMs]);
    if (stamp === this.index.stamp && this.index.complete) return [...this.index.values.values()].map((entry) => entry.value);
    const directoryId = JSON.stringify([info.dev, info.ino, info.birthtimeMs]);
    if (directoryId !== this.index.directoryId) {
      // ディレクトリが作り直されると、同じ名前のファイルでも中身は別物になるため、読み込み済みの通知は使い回せない。
      // inode が再利用されても作り直しを検出できるよう、識別子には作成時刻も含める。
      this.index.values.clear();
      this.index.cachedBytes = 0;
      this.index.directoryId = directoryId;
    }
    const names = new Set<string>();
    const result: Notification[] = [];
    let complete = true;
    for await (const entry of await opendir(this.directory)) {
      if (!entry.name.endsWith('.json')) continue;
      names.add(entry.name);
      const cached = this.index.values.get(entry.name);
      if (cached !== undefined) {
        result.push(cached.value);
        continue;
      }
      const content = await readEntirePrivateFile(join(this.directory, entry.name));
      if (content === undefined) throw new Error('Notification disappeared during read');
      const value = notification.parse(JSON.parse(content.toString('utf8')) as unknown);
      if (entry.name !== `${key(value.id)}.json` && entry.name !== `${z.uuid().parse(value.id)}.json`) throw new Error('Notification identity mismatch');
      result.push(value);
      if (!this.retain(entry.name, value, content.length)) complete = false;
    }
    for (const [name, cached] of this.index.values) {
      if (!names.has(name)) {
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
    return result;
  }

  /** 保持済みの合計サイズが上限を超える場合は保持せず、保持できたら true を返す。 */
  private retain(name: string, value: Notification, bytes: number): boolean {
    const existing = this.index.values.get(name);
    if (existing !== undefined) {
      this.index.cachedBytes -= existing.bytes;
      this.index.values.delete(name);
    }
    if (this.index.cachedBytes + bytes > MAX_CACHED_NOTIFICATION_BYTES) return false;
    this.index.values.set(name, { value, bytes });
    this.index.cachedBytes += bytes;
    return true;
  }
}
