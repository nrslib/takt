import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { invalidateAllResolvedConfigCache, invalidateGlobalConfigCache } from '../../infra/config/index.js';

export function isolateStepFragmentTestConfig(prefix: string): () => void {
  const previousConfigDir = process.env.TAKT_CONFIG_DIR;
  const configDir = mkdtempSync(join(tmpdir(), prefix));
  process.env.TAKT_CONFIG_DIR = configDir;
  invalidateGlobalConfigCache();
  invalidateAllResolvedConfigCache();
  return () => {
    if (previousConfigDir === undefined) delete process.env.TAKT_CONFIG_DIR;
    else process.env.TAKT_CONFIG_DIR = previousConfigDir;
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    rmSync(configDir, { recursive: true, force: true });
  };
}

export function writeStepFragmentTestFile(
  root: string,
  relativePath: string,
  content: string,
): string {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf-8');
  return path;
}

export function extractConfigErrorMessages(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  try {
    return JSON.parse(message).map((issue: { message: string }) => issue.message).join('\n');
  } catch {
    return message;
  }
}

export function captureConfigErrorMessage(action: () => unknown): string {
  return extractConfigErrorMessages(captureThrown(action));
}

export function captureConfigError(action: () => unknown): Error {
  const error = captureThrown(action);
  if (error instanceof Error) {
    return error;
  }
  throw error;
}

function captureThrown(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error('Expected configuration loading to fail');
}
