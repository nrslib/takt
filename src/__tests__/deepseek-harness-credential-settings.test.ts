import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  extractDeepSeekCredentialSelector,
  readDeepSeekCredentialSelector,
} from '../infra/deepseek-harness/credential-settings.js';

const DEFAULT_REF = 'DEEPSEEK_API_KEY';
const OVERSIZED_SETTINGS_BYTES = 8 * 1024 * 1024;

function captureSettingsError(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('DeepSeek credential settings were accepted unexpectedly');
}

async function captureSettingsErrorAsync(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('DeepSeek credential settings were accepted unexpectedly');
}

describe('DeepSeek Harness credential selector extraction', () => {
  it('extracts the reference and stored baseURL from the llm-deepseek section', () => {
    const selector = extractDeepSeekCredentialSelector({
      'llm-deepseek': {
        apiKeyEnv: 'MY_KEY',
        baseURL: 'https://api.deepseek.com',
      },
    });

    expect(selector.ref).toBe('MY_KEY');
    expect(selector.storedBaseUrl).toBe('https://api.deepseek.com');
  });

  it('uses the default reference when the namespace or apiKeyEnv is absent', () => {
    expect(extractDeepSeekCredentialSelector({ other: { apiKeyEnv: 'OTHER_KEY' } }).ref)
      .toBe(DEFAULT_REF);
    expect(extractDeepSeekCredentialSelector({ 'llm-deepseek': { baseURL: 'https://api.deepseek.com' } }).ref)
      .toBe(DEFAULT_REF);
  });

  it('ignores same-named keys outside the llm-deepseek section', () => {
    const selector = extractDeepSeekCredentialSelector({
      apiKeyEnv: 'ROOT_KEY',
      other: { 'llm-deepseek': { apiKeyEnv: 'NESTED_KEY' } },
      'llm-deepseek': { models: [{ apiKeyEnv: 'MODEL_KEY' }] },
    });

    expect(selector.ref).toBe(DEFAULT_REF);
    expect(selector.storedBaseUrl).toBeUndefined();
  });

  it.each([
    ['number', 123],
    ['null', null],
    ['boolean', true],
    ['array', ['MY_KEY']],
    ['record', { name: 'MY_KEY' }],
  ] as const)('rejects a %s apiKeyEnv value', (_label, value) => {
    const message = captureSettingsError(() => extractDeepSeekCredentialSelector({
      'llm-deepseek': { apiKeyEnv: value },
    }));

    expect(message).not.toContain('MY_KEY');
  });

  it.each([
    ['empty', ''],
    ['digit start', '1KEY'],
    ['dash', 'MY-KEY'],
    ['space', 'MY KEY'],
    ['dotted', 'MY.KEY'],
  ] as const)('rejects a %s credential reference', (_label, ref) => {
    const message = captureSettingsError(() => extractDeepSeekCredentialSelector({
      'llm-deepseek': { apiKeyEnv: ref },
    }));

    expect(message).toMatch(/reference|apiKeyEnv/iu);
    if (ref.length > 0) {
      expect(message).not.toContain(ref);
    }
  });
});

describe('DeepSeek Harness credential settings file reading', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'takt-deepseek-credential-settings-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function writeSettings(content: string, name = 'settings.yaml'): Promise<string> {
    const settingsPath = path.join(root, name);
    await writeFile(settingsPath, content, 'utf8');
    return settingsPath;
  }

  it('uses the default reference when the settings file does not exist', async () => {
    const selector = await readDeepSeekCredentialSelector(path.join(root, 'missing-settings.yaml'));

    expect(selector.ref).toBe(DEFAULT_REF);
    expect(selector.storedBaseUrl).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'classifies unreadable settings without misdiagnosing the selector', async () => {
      const settingsPath = await writeSettings('llm-deepseek:\n  apiKeyEnv: PRIVATE_REFERENCE\n');
      await chmod(settingsPath, 0o000);
      try {
        await expect(readDeepSeekCredentialSelector(settingsPath)).rejects.toMatchObject({
          classification: 'settings-unreadable',
        });
        const message = await captureSettingsErrorAsync(() => readDeepSeekCredentialSelector(settingsPath));
        expect(message).not.toContain(settingsPath);
        expect(message).not.toContain('PRIVATE_REFERENCE');
      } finally {
        await chmod(settingsPath, 0o600);
      }
    },
  );

  it.each(['', 123])('classifies an invalid baseURL value without blaming apiKeyEnv: %s', async (baseURL) => {
    const settingsPath = await writeSettings(JSON.stringify({ 'llm-deepseek': { baseURL } }));
    await expect(readDeepSeekCredentialSelector(settingsPath)).rejects.toMatchObject({
      classification: 'invalid-stored-endpoint',
    });
  });

  it('reads a block-style llm-deepseek selector with its stored baseURL', async () => {
    const settingsPath = await writeSettings([
      'llm-deepseek:',
      '  apiKeyEnv: MY_KEY',
      '  baseURL: https://api.deepseek.com',
      '',
    ].join('\n'));

    const selector = await readDeepSeekCredentialSelector(settingsPath);

    expect(selector.ref).toBe('MY_KEY');
    expect(selector.storedBaseUrl).toBe('https://api.deepseek.com');
  });

  it('reads a flow-style llm-deepseek selector', async () => {
    const settingsPath = await writeSettings('{llm-deepseek: {apiKeyEnv: FLOW_KEY}}\n');

    const selector = await readDeepSeekCredentialSelector(settingsPath);

    expect(selector.ref).toBe('FLOW_KEY');
  });

  it('does not treat a commented selector or a deeper key as the effective reference', async () => {
    const settingsPath = await writeSettings([
      '# apiKeyEnv: COMMENT_KEY',
      'apiKeyEnv: ROOT_KEY',
      'llm-deepseek:',
      '  models:',
      '    - apiKeyEnv: MODEL_KEY',
      '',
    ].join('\n'));

    const selector = await readDeepSeekCredentialSelector(settingsPath);

    expect(selector.ref).toBe(DEFAULT_REF);
  });

  it('rejects a duplicate selector key without echoing the document fragment', async () => {
    const settingsPath = await writeSettings([
      'llm-deepseek:',
      '  apiKeyEnv: FIRST_KEY',
      '  apiKeyEnv: SECOND_KEY',
      '',
    ].join('\n'));

    const message = await captureSettingsErrorAsync(() => readDeepSeekCredentialSelector(settingsPath));

    expect(message).not.toContain('FIRST_KEY');
    expect(message).not.toContain('SECOND_KEY');
    expect(message).not.toContain('apiKeyEnv:');
  });

  it('rejects an unparsable document without echoing the document fragment', async () => {
    const settingsPath = await writeSettings('llm-deepseek: [unclosed\n');

    const message = await captureSettingsErrorAsync(() => readDeepSeekCredentialSelector(settingsPath));

    expect(message).not.toContain('unclosed');
    expect(message).not.toContain('llm-deepseek:');
  });

  it('rejects an unresolved custom tag without evaluating it', async () => {
    const settingsPath = await writeSettings('llm-deepseek:\n  apiKeyEnv: !custom TAG_VALUE\n');

    const message = await captureSettingsErrorAsync(() => readDeepSeekCredentialSelector(settingsPath));

    expect(message).not.toContain('TAG_VALUE');
    expect(message).not.toContain('custom');
  });

  it('rejects a multi-document settings file without choosing one document', async () => {
    const settingsPath = await writeSettings([
      'llm-deepseek:',
      '  apiKeyEnv: FIRST_KEY',
      '---',
      'llm-deepseek:',
      '  apiKeyEnv: SECOND_KEY',
      '',
    ].join('\n'));

    const message = await captureSettingsErrorAsync(() => readDeepSeekCredentialSelector(settingsPath));

    expect(message).not.toContain('FIRST_KEY');
    expect(message).not.toContain('SECOND_KEY');
  });

  it('rejects a non-string selector value', async () => {
    const settingsPath = await writeSettings('llm-deepseek:\n  apiKeyEnv: 123\n');

    const message = await captureSettingsErrorAsync(() => readDeepSeekCredentialSelector(settingsPath));

    expect(message).not.toContain('123');
  });

  it('rejects an oversized settings file instead of reading it unbounded', async () => {
    const settingsPath = await writeSettings([
      'llm-deepseek:',
      '  apiKeyEnv: BIG_KEY',
      `#${'x'.repeat(OVERSIZED_SETTINGS_BYTES)}`,
      '',
    ].join('\n'));

    const message = await captureSettingsErrorAsync(() => readDeepSeekCredentialSelector(settingsPath));

    expect(message).not.toContain('BIG_KEY');
    await expect(readDeepSeekCredentialSelector(settingsPath)).rejects.toMatchObject({ classification: 'settings-too-large' });
  });
});
