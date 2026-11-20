import { afterEach, expect, it } from 'vitest';
import { RemoteCredentialsConfigSchema, DaemonConfigSchema } from '../core/models/daemon-config-schema.js';
import { resolveRemoteCredentials, remoteCredentialConfigOverrides } from '../features/workerPool/remoteCredentials.js';
import { setExecutionSecrets, redactExecutionSecrets, getExecutionSecrets, redactExecutionValue } from '../shared/utils/execution-secrets.js';
import { sanitizeSensitiveText, createSensitiveTextStreamRedactor } from '../shared/utils/sensitiveText.js';
import { sanitizeTextForStorage, sanitizeTraceParamsForMode } from '../features/tasks/execute/traceReportRedaction.js';
import { remoteGitCredentialHelper } from '../infra/task/git-credential-helper.js';
import { serializeGlobalConfig } from '../infra/config/global/globalConfigSerializer.js';
import { sanitizeRemoteFailureReason } from '../core/worker-pool/remoteFailure.js';

afterEach(() => setExecutionSecrets([]));

it.each(['z', 'xy', 'abc'])('redacts the distributed value %s inside words', (value) => {
  setExecutionSecrets([value]);
  expect(redactExecutionValue({ reason: `${value}123`, count: 1 })).toEqual({ reason: '[REDACTED]123', count: 1 });
  for (const input of [value, `${value}123`]) {
    const expected = input === value ? '[REDACTED]' : '[REDACTED]123';
    expect(redactExecutionSecrets(input)).toBe(expected);
    expect(sanitizeSensitiveText(input)).toBe(expected);
    expect(sanitizeTextForStorage(input, true)).toBe(expected);
  }
});

it('preserves redaction markers when values overlap them or each other', () => {
  setExecutionSecrets(['D', 'abc', 'ab']);
  const redacted = redactExecutionSecrets('abc123 ab9 D9');
  expect(redacted).toBe('[REDACTED]123 [REDACTED]9 [REDACTED]9');
  expect(redactExecutionSecrets(redacted)).toBe(redacted);
});

it('keeps the worker identity when redaction changes the authentication error wording', () => {
  const reason = sanitizeRemoteFailureReason('worker-a', 'OpenAI authentication failed: supplied value a9', ['a']);
  expect(reason).toBe('Worker worker-a: OpenAI [REDACTED]uthentic[REDACTED]tion f[REDACTED]iled: supplied v[REDACTED]lue [REDACTED]9');
  expect(sanitizeRemoteFailureReason('worker-a', reason, ['a'])).toBe(reason);
  expect(sanitizeRemoteFailureReason('worker-a', 'ordinary failure', [])).toBe('ordinary failure');
});

it('preserves general secret detection when a distributed value occurs in a sensitive field name', () => {
  setExecutionSecrets(['a']);
  expect(sanitizeSensitiveText('password=UPPER_VALUE')).toBe('p[REDACTED]ssword=[REDACTED]');
  expect(sanitizeRemoteFailureReason('w1', 'OpenAI authentication failed: password=UPPER_VALUE a9', ['a']))
    .toBe('Worker w1: OpenAI [REDACTED]uthentic[REDACTED]tion f[REDACTED]iled: p[REDACTED]ssword=[REDACTED] [REDACTED]9');
});

it('accepts explicit environment references and rejects plaintext credentials or unknown fields', () => {
  expect(DaemonConfigSchema.parse({ remote_worker: { host: '127.0.0.1', port: 0,
    credentials: { git: '${GIT_AUTH}', gh: '${GH_AUTH}', providers: { openai: '${PROVIDER_AUTH}' } } } }).remote_worker?.credentials?.git).toBe('${GIT_AUTH}');
  expect(RemoteCredentialsConfigSchema.safeParse({ git: 'plaintext' }).success).toBe(false);
  expect(RemoteCredentialsConfigSchema.safeParse({ token: '${AUTH}' }).success).toBe(false);
});

it('serializes credential references without resolving them or losing their daemon placement', () => {
  const credentials = RemoteCredentialsConfigSchema.parse({ git: '${GIT_AUTH}', providers: { openai: '${API_AUTH}' } });
  const serialized = serializeGlobalConfig({ language: 'en', provider: 'mock', autoFetch: false, daemon: { remoteWorker: {
    host: '127.0.0.1', port: 54322, credentials } } });
  expect(DaemonConfigSchema.parse(serialized.daemon).remote_worker).toEqual({ host: '127.0.0.1', port: 54322, credentials });
  expect(JSON.stringify(serialized)).toContain('${API_AUTH}');
});

it('resolves only configured references into task environment and leaves the source environment unchanged', () => {
  const source = { GIT_AUTH: 'fake-git-value', GH_AUTH: 'fake-gh-value', PROVIDER_AUTH: 'fake-provider-value',
    WORKER_TOKEN: 'connection-value', OPENAI_API_KEY: 'worker-value' };
  const config = RemoteCredentialsConfigSchema.parse({ git: '${GIT_AUTH}', gh: '${GH_AUTH}', providers: { openai: '${PROVIDER_AUTH}' } });
  const result = resolveRemoteCredentials(config, source);
  expect(result).toMatchObject({ TAKT_REMOTE_GIT_TOKEN: 'fake-git-value', GH_TOKEN: 'fake-gh-value',
    GITHUB_TOKEN: 'fake-gh-value', OPENAI_API_KEY: 'fake-provider-value' });
  expect(result).not.toHaveProperty('WORKER_TOKEN');
  expect(source.OPENAI_API_KEY).toBe('worker-value');
  expect(resolveRemoteCredentials(undefined, source)).toEqual({});
  expect(() => resolveRemoteCredentials(config, {})).toThrow('GIT_AUTH');
});

it('overrides worker TAKT authentication only for explicitly delivered provider keys', () => {
  const worker = { openaiApiKey: 'worker-openai', anthropicApiKey: 'worker-anthropic' };
  const delivered = { OPENAI_API_KEY: 'daemon-openai', ANTHROPIC_API_KEY: 'worker-anthropic-env',
    TAKT_REMOTE_CREDENTIAL_NAMES: '["OPENAI_API_KEY"]' };
  expect({ ...worker, ...remoteCredentialConfigOverrides(delivered) }).toEqual({ openaiApiKey: 'daemon-openai', anthropicApiKey: 'worker-anthropic' });
  expect(remoteCredentialConfigOverrides({ OPENAI_API_KEY: 'worker-openai' })).toEqual({});
});

it('redacts distributed values even when full trace storage is enabled and releases process-local values', () => {
  const secret = 'plain-fake-distributed-value';
  setExecutionSecrets([secret]);
  expect(getExecutionSecrets()).toEqual([secret]);
  expect(redactExecutionSecrets(`result ${secret}`)).toBe('result [REDACTED]');
  expect(sanitizeSensitiveText(`result ${secret}`)).toBe('result [REDACTED]');
  expect(sanitizeTextForStorage(`result ${secret}`, true)).toBe('result [REDACTED]');
  expect(sanitizeTraceParamsForMode({ task: secret } as Parameters<typeof sanitizeTraceParamsForMode>[0], 'full').task).toBe('[REDACTED]');
  setExecutionSecrets([]);
  expect(redactExecutionSecrets(secret)).toBe(secret);
});

it('redacts a supplied value split across stderr chunks before emitting it', () => {
  const redactor = createSensitiveTextStreamRedactor();
  const source = { credentials: { key: 'arbitrary-fake-value' } };
  const output = redactor.write('before arbitrary-', source)
    + redactor.write('fake-value after', source) + redactor.flush(source);
  expect(output).toBe('before [REDACTED] after');
});

it('redacts JSON values without replacing serialization syntax that happens to match a credential', () => {
  setExecutionSecrets(['"status"', '{}']);
  const result = redactExecutionValue({ status: 'failed', empty: {}, reason: 'credential "status" with {}' });
  expect(JSON.parse(JSON.stringify(result))).toEqual({ status: 'failed', empty: {}, reason: 'credential [REDACTED] with [REDACTED]' });
  setExecutionSecrets(['a']);
  expect(redactExecutionValue({ reason: 'a9', count: 1 })).toEqual({ reason: '[REDACTED]9', count: 1 });
});

it('builds a static Git helper without embedding the credential value', () => {
  expect(remoteGitCredentialHelper()).toContain('TAKT_REMOTE_GIT_TOKEN');
  expect(remoteGitCredentialHelper()).toContain('TAKT_REMOTE_GIT_ORIGIN');
  expect(remoteGitCredentialHelper()).toContain('fields.host===url.host');
});
