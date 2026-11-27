import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { writePrivateFile } from './privateFile.js';

/** 呼出し元は write の失敗を処理する。close も未完了の書込とその失敗を回収する。 */
export class DaemonLogger {
  private readonly pending = new Set<Promise<void>>();
  private readonly failures: unknown[] = [];
  private closed = false;

  constructor(private readonly configDirectory: string) {}

  async write(level: 'info' | 'error', message: string): Promise<void> {
    if (this.closed) throw new Error('Daemon logger is closed');
    if (this.pending.size >= 32 || Buffer.byteLength(message) > 16 * 1024) throw new Error('Daemon logger capacity exceeded');
    const at = new Date().toISOString();
    const operation = writePrivateFile(join(this.configDirectory, 'daemon-logs', `${at.replaceAll(':', '-')}-${randomUUID()}.json`),
      JSON.stringify({ at, level, message }));
    this.pending.add(operation);
    try { await operation; } catch (error) { this.failures.push(error); throw error; }
    finally { this.pending.delete(operation); }
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.pending]);
    if (this.failures.length > 0) throw new AggregateError(this.failures.splice(0), 'Daemon log writes failed');
  }
}
