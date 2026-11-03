import { createHash } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod/v4';
import { isMissing, listWatchEntries, MAX_WATCH_ENTRIES, readSmallJson } from './files.js';
import { startWatchLoop, WATCH_INTERVALS, type WatchLoop } from './loop.js';
import type { WatchTarget } from './observations.js';

export interface DirectoryWatchTarget extends WatchTarget {
  directory: string;
  kind: 'inbox' | 'projects' | 'workspaces';
}

/** 共有 WatchObservation にファイル変化の種類がないため、組立側へ渡す限定的な観測結果。 */
export interface WatchFileChange {
  target: DirectoryWatchTarget;
  path: string;
  generation: string;
  value: unknown;
  removed: boolean;
}

async function nearestDirectory(path: string): Promise<string> {
  let candidate = path;
  for (;;) {
    try {
      if ((await stat(candidate)).isDirectory()) return candidate;
    } catch (error) { if (!isMissing(error)) throw error; }
    const parent = dirname(candidate);
    if (parent === candidate) throw new Error('No watchable ancestor directory');
    candidate = parent;
  }
}

export function startDirectoryWatcher(dependencies: {
  targets(): Promise<readonly DirectoryWatchTarget[]>;
  changed(change: WatchFileChange): Promise<void>;
  onError(error: unknown): void;
}): WatchLoop {
  const watchers = new Map<string, { identity: string; watcher: FSWatcher }>();
  const known = new Map<string, { target: DirectoryWatchTarget; generation: string }>();
  let closed = false;
  let offset = 0;

  const loop = startWatchLoop(WATCH_INTERVALS.files, async (signal) => {
    const targets = await dependencies.targets();
    const desired = new Set<string>();
    const files = new Map<string, DirectoryWatchTarget>();
    for (const target of targets) {
      desired.add(await nearestDirectory(target.directory));
      for (const entry of await listWatchEntries(target.directory)) {
        if (entry.isFile() && entry.name.endsWith('.json') && target.kind !== 'workspaces') {
          files.set(join(target.directory, entry.name), target);
        } else if (entry.isDirectory() && target.kind === 'workspaces' && z.uuid().safeParse(entry.name).success) {
          const directory = join(target.directory, entry.name);
          desired.add(directory);
          files.set(join(directory, 'workspace.json'), target);
        }
      }
    }
    signal.throwIfAborted();
    for (const [path, entry] of watchers) {
      if (!desired.has(path)) { entry.watcher.close(); watchers.delete(path); }
    }
    for (const path of desired) {
      const info = await stat(path);
      const identity = `${info.dev}:${info.ino}`;
      if (watchers.get(path)?.identity === identity) continue;
      watchers.get(path)?.watcher.close();
      signal.throwIfAborted();
      const watcher = watch(path, { persistent: false }, () => loop.wake());
      watcher.on('error', (error) => {
        watcher.close();
        watchers.delete(path);
        dependencies.onError(error);
      });
      watchers.set(path, { identity, watcher });
    }
    const entries = [...files];
    if (offset >= entries.length) offset = 0;
    const page = entries.slice(offset, offset + MAX_WATCH_ENTRIES);
    offset += page.length;
    for (const [path, target] of page) {
      signal.throwIfAborted();
      const value = await readSmallJson(path);
      const info = await stat(path);
      const generation = createHash('sha256').update(JSON.stringify([
        target.targetId, target.generation, info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs, value,
      ])).digest('hex');
      if (known.get(path)?.generation === generation) continue;
      await dependencies.changed({ target, path, generation, value, removed: false });
      known.set(path, { target, generation });
    }
    for (const [path, previous] of known) {
      if (files.has(path)) continue;
      signal.throwIfAborted();
      // 登録解除による監視対象の除外は、受け箱そのものの削除とは区別する。
      if (targets.some((target) => target.targetId === previous.target.targetId)) {
        const generation = createHash('sha256').update(`${previous.generation}:removed`).digest('hex');
        await dependencies.changed({ target: previous.target, generation, path, value: null, removed: true });
      }
      known.delete(path);
    }
  }, dependencies.onError);

  return {
    wake: loop.wake,
    drain: loop.drain,
    async close() {
      if (!closed) {
        closed = true;
        const stopping = loop.close();
        for (const { watcher } of watchers.values()) watcher.close();
        watchers.clear();
        await stopping;
      } else await loop.close();
    },
  };
}
