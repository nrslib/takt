import { existsSync, statSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
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
});
