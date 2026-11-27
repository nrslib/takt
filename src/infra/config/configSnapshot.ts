import { AsyncLocalStorage } from 'node:async_hooks';
import { resolve } from 'node:path';
import type { GlobalConfig, ProjectConfig } from '../../core/models/config-types.js';
import type { ConfigTrace } from './traced/tracedConfigLoader.js';

interface ConfigSnapshot {
  projectDir: string;
  additionalProjectDirs?: readonly string[];
  project: ProjectConfig;
  global: GlobalConfig;
  projectTrace: ConfigTrace;
  globalTrace: ConfigTrace;
}

const snapshots = new AsyncLocalStorage<ConfigSnapshot>();

export function withConfigSnapshot<T>(snapshot: ConfigSnapshot, action: () => T): T {
  return snapshots.run({ ...snapshot, projectDir: resolve(snapshot.projectDir),
    additionalProjectDirs: snapshot.additionalProjectDirs?.map((directory) => resolve(directory)) }, action);
}

export function getConfigSnapshot(): ConfigSnapshot | undefined {
  return snapshots.getStore();
}

export function getProjectConfigSnapshot(projectDir: string): ConfigSnapshot | undefined {
  const snapshot = snapshots.getStore();
  const directory = resolve(projectDir);
  return snapshot !== undefined && (snapshot.projectDir === directory || snapshot.additionalProjectDirs?.includes(directory)) ? snapshot : undefined;
}
