import { existsSync, statSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';

const cleanupFaults = vi.hoisted(() => ({
  asyncFileFailures: 0,
  asyncDirectoryFailures: 0,
  syncFileFailures: 0,
  syncDirectoryFailures: 0,
  waitForFileRemoval: undefined as Promise<void> | undefined,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rm: async (...args: Parameters<typeof actual.rm>) => {
    const target = String(args[0]);
    if (target.includes('takt-deepseek-credentials-')) {
      if (target.endsWith('credentials.patch.yml')) {
        await cleanupFaults.waitForFileRemoval;
        if (cleanupFaults.asyncFileFailures > 0) {
          cleanupFaults.asyncFileFailures -= 1;
          throw new Error('injected patch file removal failure');
        }
      } else if (cleanupFaults.asyncDirectoryFailures > 0) {
        cleanupFaults.asyncDirectoryFailures -= 1;
        throw new Error('injected patch directory removal failure');
      }
    }
    return actual.rm(...args);
  } };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, rmSync: (...args: Parameters<typeof actual.rmSync>) => {
    const target = String(args[0]);
    if (target.includes('takt-deepseek-credentials-')) {
      if (target.endsWith('credentials.patch.yml')) {
        if (cleanupFaults.syncFileFailures > 0) {
          cleanupFaults.syncFileFailures -= 1;
          throw new Error('injected sync patch file removal failure');
        }
      } else if (cleanupFaults.syncDirectoryFailures > 0) {
        cleanupFaults.syncDirectoryFailures -= 1;
        throw new Error('injected sync patch directory removal failure');
      }
    }
    return actual.rmSync(...args);
  } };
});

import { createDeepSeekCredentialPatch } from '../infra/deepseek-harness/credential-patch.js';
import type { DeepSeekCredentialBinding } from '../infra/deepseek-harness/credential-binding.js';

const PATCH_FILE_NAME = 'credentials.patch.yml';

function createBinding(credentialsPath: string, ref: string): DeepSeekCredentialBinding {
  const homePath = path.dirname(credentialsPath);
  return {
    home: {
      origin: 'child-process-env',
      homePath,
      credentialsPath,
      settingsPath: path.join(homePath, 'settings.yaml'),
    },
    ref,
    endpoint: 'https://api.deepseek.com',
    fingerprint: `${homePath}:${ref}`,
  };
}

async function readPatchDocument(patchPath: string): Promise<unknown> {
  return parseYaml(await readFile(patchPath, 'utf8'));
}

describe('DeepSeek Harness credential patch', () => {
  let root: string;

  beforeEach(async () => {
    cleanupFaults.asyncFileFailures = 0;
    cleanupFaults.asyncDirectoryFailures = 0;
    cleanupFaults.syncFileFailures = 0;
    cleanupFaults.syncDirectoryFailures = 0;
    cleanupFaults.waitForFileRemoval = undefined;
    root = await mkdtemp(path.join(os.tmpdir(), 'takt-deepseek-credential-patch-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('writes the credential binding and disables durable runtime sessions and log uploads in a private patch file', async () => {
    const credentialsPath = path.join(root, 'source-home', '.credentials.yaml');
    const patch = await createDeepSeekCredentialPatch(createBinding(credentialsPath, 'CUSTOM_KEY'));
    try {
      expect(existsSync(patch.path)).toBe(true);
      expect(path.basename(patch.path)).toBe(PATCH_FILE_NAME);
      expect(await readPatchDocument(patch.path)).toEqual([
        { id: 'credentials', config: { path: credentialsPath } },
        { id: 'llm-deepseek', config: { apiKeyEnv: 'CUSTOM_KEY' } },
        { id: 'session-persistence-jsonl', disabled: true },
        { id: 'session-log-deepseek', config: { enabled: false } },
      ]);
      const content = await readFile(patch.path, 'utf8');
      expect(content).not.toContain('baseURL');
      expect(content).not.toContain('secret');
    } finally {
      await patch.dispose();
    }
  });

  it('keeps the source store available while routing an explicit credential through a private reference', async () => {
    const credentialsPath = path.join(root, 'source-home', '.credentials.yaml');
    const patch = await createDeepSeekCredentialPatch(
      createBinding(credentialsPath, 'CUSTOM_KEY'),
      undefined,
      [],
      { runtimeCredentialReference: 'TAKT_DSH_EXPLICIT_TEST' },
    );
    try {
      const document = await readPatchDocument(patch.path) as Array<Record<string, unknown>>;
      const runtimeCredentialsPath = (document[0]?.config as { path?: string } | undefined)?.path;
      expect(runtimeCredentialsPath).toBe(credentialsPath);
      expect(existsSync(path.join(path.dirname(patch.path), 'environment-credentials.yaml'))).toBe(false);
      expect(await readPatchDocument(patch.path)).toContainEqual({
        id: 'llm-deepseek',
        config: { apiKeyEnv: 'TAKT_DSH_EXPLICIT_TEST' },
      });
    } finally {
      await patch.dispose();
    }
  });

  it('passes a complete literal system prompt through the public Cordis patch API', async () => {
    const credentialsPath = path.join(root, 'source-home', '.credentials.yaml');
    const systemPrompt = 'Use {{unknown_template}} literally.\nKeep these braces: {{ and }}.';
    const patch = await createDeepSeekCredentialPatch(
      createBinding(credentialsPath, 'CUSTOM_KEY'),
      systemPrompt,
    );
    try {
      const document = await readPatchDocument(patch.path) as Array<Record<string, unknown>>;
      expect(document.some((row) => String(row.id).startsWith('tool-'))).toBe(false);
      expect(document).toContainEqual({ id: 'session-persistence-jsonl', disabled: true });
      expect(document).toContainEqual({ id: 'session-log-deepseek', config: { enabled: false } });
      const pluginPatch = document.at(-1);
      expect(pluginPatch).toMatchObject({
        insert: [{
          id: 'takt-system-prompt',
          name: new URL('../infra/deepseek-harness/system-prompt-plugin.mjs', import.meta.url).href,
          inject: ['systemPrompt'],
          config: { prompt: systemPrompt },
        }],
      });
      expect(statSync(patch.path).mode & 0o777).toBe(0o600);
    } finally {
      await patch.dispose();
    }
  });

  it('adds resolved Git plugins without adding source URLs to the Cordis patch', async () => {
    const patch = await createDeepSeekCredentialPatch(
      createBinding(path.join(root, '.credentials.yaml'), 'DEEPSEEK_API_KEY'),
      undefined,
      [{
        id: 'example-plugin',
        name: 'file:///tmp/plugin/index.js',
        config: { enabled: true },
      }],
    );
    try {
      const document = await readPatchDocument(patch.path) as Array<Record<string, unknown>>;
      expect(document.slice(0, 2)).toEqual([
        { id: 'credentials', config: { path: path.join(root, '.credentials.yaml') } },
        { id: 'llm-deepseek', config: { apiKeyEnv: 'DEEPSEEK_API_KEY' } },
      ]);
      expect(document.at(-1)).toEqual({
        insert: [{
          id: 'example-plugin',
          name: 'file:///tmp/plugin/index.js',
          config: { enabled: true },
        }],
      });
      expect(document).toContainEqual({ id: 'session-persistence-jsonl', disabled: true });
      expect(document).toContainEqual({ id: 'session-log-deepseek', config: { enabled: false } });
    } finally {
      await patch.dispose();
    }
  });

  it.skipIf(process.platform === 'win32')('creates the patch file and its directory with private modes', async () => {
    const patch = await createDeepSeekCredentialPatch(
      createBinding(path.join(root, '.credentials.yaml'), 'DEEPSEEK_API_KEY'),
    );
    try {
      expect(statSync(patch.path).mode & 0o777).toBe(0o600);
      expect(statSync(path.dirname(patch.path)).mode & 0o777).toBe(0o700);
    } finally {
      await patch.dispose();
    }
  });

  it('disposes the patch file and its directory, and disposing twice is a no-op', async () => {
    const patch = await createDeepSeekCredentialPatch(
      createBinding(path.join(root, '.credentials.yaml'), 'DEEPSEEK_API_KEY'),
    );
    const directory = path.dirname(patch.path);

    await patch.dispose();
    expect(existsSync(patch.path)).toBe(false);
    expect(existsSync(directory)).toBe(false);
    await expect(patch.dispose()).resolves.toBeUndefined();
  });

  it('keeps two concurrently created patches apart and disposes each one', async () => {
    const first = await createDeepSeekCredentialPatch(
      createBinding(path.join(root, 'first-home', '.credentials.yaml'), 'FIRST_KEY'),
    );
    const second = await createDeepSeekCredentialPatch(
      createBinding(path.join(root, 'second-home', '.credentials.yaml'), 'SECOND_KEY'),
    );

    expect(first.path).not.toBe(second.path);
    expect(await readPatchDocument(first.path)).toEqual([
      { id: 'credentials', config: { path: path.join(root, 'first-home', '.credentials.yaml') } },
      { id: 'llm-deepseek', config: { apiKeyEnv: 'FIRST_KEY' } },
      { id: 'session-persistence-jsonl', disabled: true },
      { id: 'session-log-deepseek', config: { enabled: false } },
    ]);
    expect(await readPatchDocument(second.path)).toEqual([
      { id: 'credentials', config: { path: path.join(root, 'second-home', '.credentials.yaml') } },
      { id: 'llm-deepseek', config: { apiKeyEnv: 'SECOND_KEY' } },
      { id: 'session-persistence-jsonl', disabled: true },
      { id: 'session-log-deepseek', config: { enabled: false } },
    ]);

    await Promise.all([first.dispose(), second.dispose()]);
    expect(existsSync(path.dirname(first.path))).toBe(false);
    expect(existsSync(path.dirname(second.path))).toBe(false);
  });

  it('removes its owned directory on synchronous cleanup and tolerates later async cleanup', async () => {
    const patch = await createDeepSeekCredentialPatch(
      createBinding(path.join(root, '.credentials.yaml'), 'DEEPSEEK_API_KEY'),
    );
    patch.disposeSync();
    expect(existsSync(path.dirname(patch.path))).toBe(false);
    patch.disposeSync();
    await expect(patch.dispose()).resolves.toBeUndefined();
  });

  it.each(['file', 'directory'] as const)('retries asynchronous cleanup after the %s removal fails', async (target) => {
    const patch = await createDeepSeekCredentialPatch(createBinding(path.join(root, '.credentials.yaml'), 'DEEPSEEK_API_KEY'));
    const directory = path.dirname(patch.path);
    if (target === 'file') cleanupFaults.asyncFileFailures = 1;
    else cleanupFaults.asyncDirectoryFailures = 1;
    try {
      await expect(patch.dispose()).rejects.toThrow(`injected patch ${target} removal failure`);
      expect(existsSync(directory)).toBe(true);
      await patch.dispose();
      expect(existsSync(directory)).toBe(false);
    } finally {
      cleanupFaults.asyncFileFailures = 0;
      cleanupFaults.asyncDirectoryFailures = 0;
      await patch.dispose();
    }
  });

  it.each(['file', 'directory'] as const)('retries synchronous cleanup after the %s removal fails', async (target) => {
    const patch = await createDeepSeekCredentialPatch(createBinding(path.join(root, '.credentials.yaml'), 'DEEPSEEK_API_KEY'));
    const directory = path.dirname(patch.path);
    if (target === 'file') cleanupFaults.syncFileFailures = 1;
    else cleanupFaults.syncDirectoryFailures = 1;
    try {
      expect(() => patch.disposeSync()).toThrow(`injected sync patch ${target} removal failure`);
      expect(existsSync(directory)).toBe(true);
      patch.disposeSync();
      expect(existsSync(directory)).toBe(false);
    } finally {
      cleanupFaults.syncFileFailures = 0;
      cleanupFaults.syncDirectoryFailures = 0;
      await patch.dispose();
    }
  });

  it('shares a pending asynchronous cleanup with concurrent callers', async () => {
    const patch = await createDeepSeekCredentialPatch(createBinding(path.join(root, '.credentials.yaml'), 'DEEPSEEK_API_KEY'));
    let releaseRemoval!: () => void;
    cleanupFaults.waitForFileRemoval = new Promise<void>((resolve) => { releaseRemoval = resolve; });
    try {
      const first = patch.dispose();
      const second = patch.dispose();
      expect(second).toBe(first);
      expect(existsSync(patch.path)).toBe(true);
      releaseRemoval();
      await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
      expect(existsSync(path.dirname(patch.path))).toBe(false);
    } finally {
      releaseRemoval();
      cleanupFaults.waitForFileRemoval = undefined;
      await patch.dispose();
    }
  });

  it('keeps asynchronous callers waiting when synchronous cleanup finishes first', async () => {
    const patch = await createDeepSeekCredentialPatch(createBinding(path.join(root, '.credentials.yaml'), 'DEEPSEEK_API_KEY'));
    let releaseRemoval!: () => void;
    cleanupFaults.waitForFileRemoval = new Promise<void>((resolve) => { releaseRemoval = resolve; });
    try {
      const pending = patch.dispose();
      patch.disposeSync();
      expect(existsSync(path.dirname(patch.path))).toBe(false);
      expect(patch.dispose()).toBe(pending);
      releaseRemoval();
      await expect(pending).resolves.toBeUndefined();
    } finally {
      releaseRemoval();
      cleanupFaults.waitForFileRemoval = undefined;
      await patch.dispose();
    }
  });
});
