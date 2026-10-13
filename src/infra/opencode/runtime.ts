import { execFile } from 'node:child_process';
import { buildChildProcessEnv } from '../../shared/utils/child-process-env.js';

export interface OpenCodeRuntime {
  generation: 'v1' | 'v2';
  command: string;
  version: string;
}

export function openCodeRuntimeSelection(): { generation: 'v1' | 'v2'; command: string } {
  const generation = process.env.TAKT_OPENCODE_VERSION ?? 'v2';
  if (generation !== 'v1' && generation !== 'v2') {
    throw new Error('TAKT_OPENCODE_VERSION must be v1 or v2');
  }
  const command = process.env.TAKT_OPENCODE_PATH ?? 'opencode';
  if (command.trim() === '') throw new Error('TAKT_OPENCODE_PATH must not be empty');
  return { generation, command };
}

export async function resolveOpenCodeRuntime(abortSignal?: AbortSignal): Promise<OpenCodeRuntime> {
  abortSignal?.throwIfAborted();
  const selection = openCodeRuntimeSelection();
  const version = await new Promise<string>((resolve, reject) => {
    execFile(selection.command, ['--version'], { timeout: 10_000, env: buildChildProcessEnv(), signal: abortSignal }, (error, stdout) => {
      if (error) reject(new Error('Cannot read OpenCode CLI version. Install the selected CLI or set TAKT_OPENCODE_PATH.', { cause: error }));
      else resolve(String(stdout).trim());
    });
  });
  const match = /^(?:opencode v)?(\d+)\.\d+\.\d+(?:[-+][\w.-]+)?$/.exec(version);
  const expectedMajor = selection.generation === 'v1' ? '1' : '2';
  if (match?.[1] !== expectedMajor) {
    throw new Error(`OpenCode CLI ${version} is incompatible with TAKT's ${selection.generation} transport. Set TAKT_OPENCODE_VERSION=v1 or v2 and TAKT_OPENCODE_PATH to a matching CLI.`);
  }
  return { ...selection, version };
}
