export type TaktEnvSnapshot = Record<string, string | undefined>;

function isTaktEnvKey(key: string): boolean {
  return key.startsWith('TAKT_');
}

export function snapshotTaktEnv(): TaktEnvSnapshot {
  const snapshot: TaktEnvSnapshot = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (isTaktEnvKey(key)) {
      snapshot[key] = value;
    }
  }
  return snapshot;
}

export function clearTaktEnv(): TaktEnvSnapshot {
  const snapshot = snapshotTaktEnv();
  for (const key of Object.keys(process.env)) {
    if (isTaktEnvKey(key)) {
      delete process.env[key];
    }
  }
  return snapshot;
}

export function restoreTaktEnv(snapshot: TaktEnvSnapshot): void {
  for (const key of Object.keys(process.env)) {
    if (isTaktEnvKey(key) && !Object.prototype.hasOwnProperty.call(snapshot, key)) {
      delete process.env[key];
    }
  }

  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[key];
      continue;
    }
    process.env[key] = value;
  }
}
