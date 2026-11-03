import { lstat } from 'node:fs/promises';
import { GoalSchema, type Goal } from '../goals/schema.js';
import { readPrivateFile } from './privateFile.js';

const MAX_DISPLAY_BYTES = 4 * 1024 * 1024;
export async function readDisplayFile(path: string): Promise<unknown> {
  const content = await readPrivateFile(path, MAX_DISPLAY_BYTES);
  if (content === undefined) throw new Error(`Display file disappeared: ${path}`);
  return JSON.parse(content.toString('utf8')) as unknown;
}

/** 更新を毎回照合し、既存の画面更新で同じ履歴を繰り返し解析しない。 */
export class DaemonDisplayFiles {
  private readonly goals = new Map<string, { stamp: string; bytes: number; value: Goal }>();
  private bytes = 0;

  private forget(path: string): void {
    const saved = this.goals.get(path);
    if (saved !== undefined) { this.bytes -= saved.bytes; this.goals.delete(path); }
  }

  async goal(path: string): Promise<Goal> {
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.size > MAX_DISPLAY_BYTES) throw new Error(`Invalid display file: ${path}`);
      const stamp = JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]);
      const cached = this.goals.get(path);
      if (cached?.stamp === stamp) return structuredClone(cached.value);
      const value = GoalSchema.parse(await readDisplayFile(path));
      this.forget(path);
      const bytes = Buffer.byteLength(JSON.stringify(value));
      if (bytes > MAX_DISPLAY_BYTES) return value;
      while (this.bytes + bytes > MAX_DISPLAY_BYTES || this.goals.size >= 128) this.forget(this.goals.keys().next().value!);
      this.goals.set(path, { stamp, bytes, value }); this.bytes += bytes;
      return structuredClone(value);
    } catch (error) { this.forget(path); throw error; }
  }
}
