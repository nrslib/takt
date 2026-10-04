import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  resolveDeepSeekCredentialBinding,
  type ResolveDeepSeekCredentialBindingOptions,
} from '../infra/deepseek-harness/credential-binding.js';

describe('DeepSeek Harness credential binding resolution', () => {
  let root: string;
  let sourceHome: string;
  let settingsPath: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'takt-binding-'));
    sourceHome = path.join(root, '.dsh');
    await mkdir(sourceHome);
    settingsPath = path.join(sourceHome, 'settings.yaml');
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  function resolve(overrides: Partial<ResolveDeepSeekCredentialBindingOptions> = {}) {
    return resolveDeepSeekCredentialBinding({ userHome: root, ambientEnv: {}, ...overrides });
  }

  it('binds an explicit source home, default reference and endpoint with missing settings', async () => {
    const binding = await resolve({ childProcessEnv: { DSH_HOME: sourceHome } });
    expect(binding.home.origin).toBe('child-process-env');
    expect(binding.home.homePath).toBe(sourceHome);
    expect(binding.home.credentialsPath).toBe(path.join(sourceHome, '.credentials.yaml'));
    expect(binding.ref).toBe('DEEPSEEK_API_KEY');
    expect(binding.endpoint).toBe('https://api.deepseek.com');
    expect(binding.fingerprint.length).toBeGreaterThan(0);
  });

  it('reads the actual settings file from the selected source home', async () => {
    await writeFile(settingsPath, 'llm-deepseek:\n  apiKeyEnv: CUSTOM_KEY\n');
    const binding = await resolve({ childProcessEnv: { DSH_HOME: sourceHome } });
    expect(binding.ref).toBe('CUSTOM_KEY');
  });

  it('accepts a matching stored endpoint and classifies a mismatch', async () => {
    await writeFile(settingsPath, 'llm-deepseek:\n  baseURL: https://api.deepseek.com/v1\n');
    const options = { providerOptions: { baseUrl: 'https://api.deepseek.com/v1' } };
    expect((await resolve(options)).endpoint).toBe(options.providerOptions.baseUrl);
    await writeFile(settingsPath, 'llm-deepseek:\n  baseURL: https://other.example/v1\n');
    await expect(resolve(options)).rejects.toMatchObject({ classification: 'endpoint-mismatch' });
  });

  it.each([
    ['invalid-settings', 'llm-deepseek: [untrusted-secret'],
    ['invalid-selector', 'llm-deepseek:\n  apiKeyEnv: 1INVALID\n'],
    ['invalid-stored-endpoint', 'llm-deepseek:\n  baseURL: 123\n'],
    ['settings-too-large', '#'.repeat(1024 * 1024 + 1)],
  ])('preserves the safe settings classification: %s', async (classification, content) => {
    await writeFile(settingsPath, content);
    await expect(resolve()).rejects.toMatchObject({ classification });
    await expect(resolve()).rejects.not.toThrow('untrusted-secret');
  });

  it('classifies a non-regular settings file as unreadable', async () => {
    await mkdir(settingsPath);
    await expect(resolve()).rejects.toMatchObject({ classification: 'settings-unreadable' });
  });

  it.each(['not-a-url', 'ftp://example.com', 'https://user:dummy-secret@example.com'])(
    'classifies invalid effective endpoints without stored settings: %s', async (baseUrl) => {
      await expect(resolve({ providerOptions: { baseUrl } })).rejects.toMatchObject({
        classification: 'invalid-effective-endpoint',
      });
    },
  );

  it.each(['not-a-url', 'ftp://example.com', 'https://user:dummy-secret@example.com'])(
    'classifies malformed stored endpoints separately: %s', async (baseUrl) => {
      await writeFile(settingsPath, `llm-deepseek:\n  baseURL: ${baseUrl}\n`);
      await expect(resolve()).rejects.toMatchObject({ classification: 'invalid-stored-endpoint' });
      await expect(resolve()).rejects.not.toThrow('dummy-secret');
    },
  );

  it('keeps one fingerprint for identical non-secret inputs', async () => {
    expect((await resolve()).fingerprint).toBe((await resolve()).fingerprint);
  });

  it('changes the fingerprint when the source home changes', async () => {
    const first = await resolve();
    const second = await resolve({ childProcessEnv: { DSH_HOME: path.join(root, 'other') } });
    expect(first.fingerprint).not.toBe(second.fingerprint);
  });

  it('changes the fingerprint when the selected reference changes', async () => {
    await writeFile(settingsPath, 'llm-deepseek:\n  apiKeyEnv: FIRST_KEY\n');
    const first = await resolve();
    await writeFile(settingsPath, 'llm-deepseek:\n  apiKeyEnv: SECOND_KEY\n');
    expect(first.fingerprint).not.toBe((await resolve()).fingerprint);
  });

  it('changes the fingerprint when the endpoint changes', async () => {
    const first = await resolve({ providerOptions: { baseUrl: 'https://first.example/v1' } });
    const second = await resolve({ providerOptions: { baseUrl: 'https://second.example/v1' } });
    expect(first.fingerprint).not.toBe(second.fingerprint);
  });

  it('does not include selected environment credential values in the fingerprint', async () => {
    await writeFile(settingsPath, 'llm-deepseek:\n  apiKeyEnv: CUSTOM_KEY\n');
    const first = await resolve({ childProcessEnv: { CUSTOM_KEY: 'first-secret-value' } });
    const second = await resolve({ childProcessEnv: { CUSTOM_KEY: 'second-secret-value' } });
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.fingerprint).not.toContain('first-secret-value');
    expect(first.fingerprint).not.toContain('second-secret-value');
  });
});
