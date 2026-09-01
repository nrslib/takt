import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProviderEventLogger } from '../core/logging/providerEventLogger.js';
import {
  callDeepSeekHarness,
  closeDeepSeekHarnessProcesses,
} from '../infra/deepseek-harness/index.js';

function isSupportedPythonVersion(version: readonly [number, number]): boolean {
  const minimum: readonly [number, number] = [3, 10];
  return version[0] > minimum[0]
    || (version[0] === minimum[0] && version[1] >= minimum[1]);
}

function findPython(): string | undefined {
  const candidates = process.platform === 'win32' ? ['python'] : ['python3', 'python'];
  for (const candidate of candidates) {
    try {
      const details = execFileSync(candidate, [
        '-c',
        'import os, sys; print(sys.version_info[:2]); print(os.path.realpath(sys.executable))',
      ], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const [version, executable] = details.trim().split(/\r?\n/u);
      const match = /\((\d+), (\d+)\)/u.exec(version ?? '');
      const parsedVersion: readonly [number, number] | undefined = match === null
        ? undefined
        : [Number(match[1]), Number(match[2])];
      if (
        parsedVersion !== undefined
        && isSupportedPythonVersion(parsedVersion)
        && executable !== undefined
        && path.isAbsolute(executable)
      ) {
        return executable;
      }
    } catch {
      // Try the next supported interpreter name.
    }
  }
  return undefined;
}

const supportedPlatform = (
  (process.platform === 'linux' && (process.arch === 'x64' || process.arch === 'arm64'))
  || (process.platform === 'darwin' && process.arch === 'arm64')
);
const supportedRuntime = supportedPlatform && findPython() !== undefined;

it.skipIf(supportedPlatform)('DeepSeek Harness fails fast with an actionable unsupported-platform error', async () => {
  const response = await callDeepSeekHarness('worker', 'hello', { cwd: process.cwd() });

  expect(response.status).toBe('error');
  expect(response.content).toContain('Linux x64/arm64 or macOS arm64');
  expect(response.content).toContain('no provider fallback is available');
});

it.skipIf(!supportedPlatform || supportedRuntime)('DeepSeek Harness fails fast with an actionable missing-Python error on a supported platform', async () => {
  const response = await callDeepSeekHarness('worker', 'hello', { cwd: process.cwd() });

  expect(response.status).toBe('error');
  expect(response.content).toContain('Python 3.10');
});

describe.skipIf(!supportedRuntime)('DeepSeek Harness bridge lifecycle', () => {
  let root: string;
  let pythonPath: string;

  beforeEach(async () => {
    const python = findPython();
    if (python === undefined) {
      throw new Error('Python 3.10+ was detected during suite selection but is unavailable');
    }
    root = await mkdtemp(path.join(os.tmpdir(), 'takt-deepseek-harness-'));
    const moduleDir = path.join(root, 'deepseek_harness');
    await mkdir(moduleDir);
    await writeFile(path.join(moduleDir, '__init__.py'), `
import json
import os
import threading
import time

class Notification:
    def __init__(self, method, payload):
        self.method = method
        self.payload = payload

class Result:
    def __init__(self, session_id, final_response, finish_reason):
        self.session_id = session_id
        self.final_response = final_response
        self.finish_reason = finish_reason

class SdkProtocolError(Exception):
    pass

class JsonRpcError(Exception):
    pass

class DeepSeekHarness:
    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.closed = False
        config_file = os.path.join(kwargs['cwd'], 'bridge-start-configs.jsonl')
        with open(config_file, 'a', encoding='utf-8') as config:
            config.write(json.dumps(kwargs, sort_keys=True) + '\\n')
        if kwargs.get('provider') == 'unknown-route':
            raise RuntimeError('SDK rejected unknown provider route "unknown-route"')
        if kwargs.get('model') == 'unknown-model':
            raise RuntimeError('SDK rejected unknown model "unknown-model"')
        if kwargs.get('provider') == 'not-found-route':
            raise RuntimeError('SDK provider route not found "not-found-route"')
        if kwargs.get('model') == 'enoent-model':
            raise RuntimeError('ENOENT: SDK model not found "enoent-model"')
        if kwargs.get('model') == 'runtime-unavailable-model':
            raise FileNotFoundError('missing DeepSeek Harness runtime wheel')
        if kwargs.get('model') == 'terminal-diagnostic-model':
            raise RuntimeError('SDK diagnostic \\x1b]52;clipboard\\x07\\x1b[31mraw\\x1b[0m\\x01')
        counter_file = kwargs.get('session_root')
        if counter_file:
            with open(counter_file, 'a', encoding='utf-8') as counter:
                counter.write('initialized\\n')

    def start(self):
        if os.path.basename(self.kwargs.get('cordis', '')) == 'FAKE_START_FAILURE':
            raise RuntimeError('startup failure')

    def close(self):
        if os.path.basename(self.kwargs.get('cordis', '')) == 'FAKE_CLOSE_HANG':
            time.sleep(30)
        self.closed = True

    def start_session(self, session_id=None):
        harness = self
        active_session = session_id or 'generated-session'
        class Session:
            id = active_session
            def run(self, input, *, on_notification=None):
                return harness.run(input, session_id=active_session, on_notification=on_notification)
        return Session()

    def run(self, input, *, session_id=None, on_notification=None):
        if input == 'hang':
            time.sleep(30)
        if input == 'fail-secret':
            raise RuntimeError(os.environ.get('DEEPSEEK_API_KEY', 'missing-secret'))
        if input == 'malformed-json':
            print('not-json', flush=True)
        if input == 'jsonrpc-failure':
            raise JsonRpcError('jsonrpc failure')
        if input == 'unexpected-exit':
            os._exit(23)
        active_session = session_id or 'generated-session'
        if input.startswith('capture-prompt:'):
            with open(os.path.join(self.kwargs['cwd'], 'received-prompt.txt'), 'w', encoding='utf-8') as prompt_file:
                prompt_file.write(input)
        if input == 'inspect-env':
            environment = {}
            for name in ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'OPENAI_API_KEY', 'TAKT_OBSERVABILITY_ENABLED', 'HOME', 'DSH_RUNTIME_MODE']:
                value = os.environ.get(name)
                if value is not None:
                    environment[name] = value
            with open(os.path.join(self.kwargs['cwd'], 'bridge-env.json'), 'w', encoding='utf-8') as env_file:
                json.dump(environment, env_file)
        secret = os.environ.get('DEEPSEEK_API_KEY', '')
        secret_events = input == 'secret-events'
        tool_id = 'call-' + secret if input == 'secret-tool-id' else 'call-1'
        finish_reason = input.split(':', 1)[1] if input.startswith('reason:') else 'completed'
        event_finish_reason = 'blocked' if input == 'mismatched-reason' else finish_reason
        result_finish_reason = None if input == 'missing-result-reason' else finish_reason
        text = secret if secret_events else 'hello'
        tool_arguments = '{"path":"' + (secret if secret_events else 'README.md') + '"}'
        events = [
            {'type': 'assistant/chunk', 'data': {'chunk': {'type': 'reasoning-delta', 'text': secret if secret_events else 'thinking'}}},
            {'type': 'tool/call', 'data': {'callId': tool_id, 'name': 'read', 'arguments': tool_arguments}},
            {'type': 'tool/result', 'data': {'message': {'source': {'callId': tool_id}, 'content': [{'type': 'tool-result', 'toolCallId': tool_id, 'content': [{'type': 'text', 'text': secret if secret_events else 'file'}]}]}}},
            {'type': 'assistant/chunk', 'data': {'chunk': {'type': 'text-delta', 'text': text}}},
            {'type': 'turn/end', 'data': {'reason': {'kind': event_finish_reason, **({'error': {'code': 'FAKE', 'message': 'provider failure'}} if event_finish_reason == 'error' else {})}}},
        ]
        if input == 'message-events':
            events = [
                {'type': 'assistant/message', 'data': {'message': {'content': [{'type': 'text', 'text': 'first'}]}}},
                {'type': 'assistant/message', 'data': {'message': {'content': [{'type': 'text', 'text': 'second'}]}}},
                {'type': 'turn/end', 'data': {'reason': {'kind': 'completed'}}},
            ]
        if input == 'malformed-frame':
            events = [
                {'type': 'assistant/chunk', 'data': {'chunk': {'type': 'text-delta', 'text': float('nan')}}},
            ]
        if input == 'malformed-notification':
            events = [
                {'type': 'assistant/chunk', 'data': {}},
            ]
        if input == 'concurrent-events':
            events = [
                {'type': 'assistant/chunk', 'data': {'chunk': {'type': 'text-delta', 'text': str(index)}}}
                for index in range(32)
            ] + [{'type': 'turn/end', 'data': {'reason': {'kind': 'completed'}}}]
        if input == 'missing-turn-end':
            events = events[:-1]
        if on_notification is not None:
            if input == 'concurrent-events':
                threads = [threading.Thread(
                    target=on_notification,
                    args=(Notification('session.event', {'sessionId': active_session, 'event': event}),),
                ) for event in events]
                for thread in threads:
                    thread.start()
                for thread in threads:
                    thread.join()
            else:
                for event in events:
                    on_notification(Notification('session.event', {'sessionId': active_session, 'event': event}))
        final_response = 'firstsecond' if input == 'message-events' else (secret if secret_events else 'hello')
        return Result(active_session, final_response, result_finish_reason)
`, 'utf8');
    pythonPath = path.join(root, 'python-wrapper.sh');
    await writeFile(pythonPath, `#!/bin/sh\nPYTHONPATH="${root}:${'${PYTHONPATH:-}'}" exec "${python}" "$@"\n`, 'utf8');
    await chmod(pythonPath, 0o755);
  });

  afterEach(async () => {
    await closeDeepSeekHarnessProcesses();
    await rm(root, { recursive: true, force: true });
  });

  it('converts official SDK notifications and closes one-shot sessions', async () => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const response = await callDeepSeekHarness('worker', 'hello', {
      cwd: root,
      providerOptions: {
        pythonPath,
        requestTimeoutMs: 10_000,
      },
      onStream: (event) => events.push(event as { type: string; data: Record<string, unknown> }),
    });

    expect(response).toMatchObject({ status: 'done', content: 'hello', sessionId: 'generated-session' });
    expect(events).toEqual(expect.arrayContaining([
      { type: 'thinking', data: { thinking: 'thinking' } },
      { type: 'tool_use', data: { id: 'call-1', tool: 'read', input: { path: 'README.md' } } },
      { type: 'tool_result', data: { id: 'call-1', content: 'file', isError: false } },
      { type: 'text', data: { text: 'hello' } },
      expect.objectContaining({ type: 'result', data: expect.objectContaining({ success: true }) }),
    ]));
    expect(events
      .filter((event) => event.type === 'init' || event.type === 'result')
      .map((event) => event.data.sessionId))
      .toEqual([response.sessionId, response.sessionId]);

    const [configuration] = (await readFile(path.join(root, 'bridge-start-configs.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(configuration).toMatchObject({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
    });
  });

  it.each([
    ['openai/gpt-5.4', 'openai', 'gpt-5.4'],
    ['my-gateway/org/custom-model', 'my-gateway', 'org/custom-model'],
    ['my-gateway/ollama/qwen3.5:397b', 'my-gateway', 'ollama/qwen3.5:397b'],
    ['route//model', 'route', '/model'],
    [' unknown-route / unknown-model ', ' unknown-route ', ' unknown-model '],
    ['deepseek-v4-flash', 'deepseek-official', 'deepseek-v4-flash'],
    [' deepseek-v4-flash ', 'deepseek-official', ' deepseek-v4-flash '],
  ] as const)('passes the effective route and model separately to the SDK for %s', async (model, provider, modelId) => {
    const response = await callDeepSeekHarness('worker', 'hello', {
      cwd: root,
      model,
      providerOptions: { pythonPath, requestTimeoutMs: 10_000 },
    });
    const [configuration] = (await readFile(path.join(root, 'bridge-start-configs.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(response.status).toBe('done');
    expect(configuration).toMatchObject({ provider, model: modelId });
  });

  it.each([
    ['', '""'],
    ['   ', '   '],
    ['/model', '/model'],
    ['route/', 'route/'],
  ] as const)('rejects malformed model reference %s before starting the bridge', async (model, referenceContext) => {
    const response = await callDeepSeekHarness('worker', 'hello', {
      cwd: root,
      model,
      providerOptions: { pythonPath, requestTimeoutMs: 10_000 },
    });

    expect(response.status).toBe('error');
    expect(response.content).toContain(referenceContext);
    expect(response.content).toMatch(/empty|route|model/iu);
    await expect(readFile(path.join(root, 'bridge-start-configs.jsonl'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    [
      'unknown-route/known-model',
      'unknown-route',
      'known-model',
      'SDK rejected unknown provider route "unknown-route"',
    ],
    [
      'known-route/unknown-model',
      'known-route',
      'unknown-model',
      'SDK rejected unknown model "unknown-model"',
    ],
    [
      'not-found-route/known-model',
      'not-found-route',
      'known-model',
      'SDK provider route not found "not-found-route"',
    ],
    [
      'known-route/enoent-model',
      'known-route',
      'enoent-model',
      'ENOENT: SDK model not found "enoent-model"',
    ],
  ] as const)('reports the original reference and bridge/SDK failure for %s', async (reference, provider, modelId, sdkFailure) => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const response = await callDeepSeekHarness('worker', 'hello', {
      cwd: root,
      model: reference,
      providerOptions: { pythonPath, requestTimeoutMs: 10_000 },
      onStream: (event) => events.push(event as { type: string; data: Record<string, unknown> }),
    });
    const [configuration] = (await readFile(path.join(root, 'bridge-start-configs.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(response.status).toBe('error');
    expect(configuration).toMatchObject({ provider, model: modelId });
    expect(response.content).toContain(reference);
    expect(response.content).toContain(provider);
    expect(response.content).toContain(modelId);
    expect(response.content).toContain(sdkFailure);
    expect(events).toEqual(expect.arrayContaining([
      { type: 'error', data: { message: response.content, raw: response.content } },
      expect.objectContaining({
        type: 'result',
        data: expect.objectContaining({
          error: response.content,
          success: false,
          failureCategory: 'provider_error',
        }),
      }),
    ]));
    expect(events.some((event) => event.type === 'result' && event.data.success === true)).toBe(false);
  });

  it('sanitizes terminal control sequences in provider errors and stream events', async () => {
    const reference = '\u009d52;c;X\u007fterminal-route/terminal-diagnostic-model';
    const sanitizedReference = `DeepSeek Harness model reference ${JSON.stringify(reference)}`
      .replace('\u009d', '\\x9d')
      .replace('\u007f', '\\x7f');
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const response = await callDeepSeekHarness('worker', 'hello', {
      cwd: root,
      model: reference,
      providerOptions: { pythonPath, requestTimeoutMs: 10_000 },
      onStream: (event) => events.push(event as { type: string; data: Record<string, unknown> }),
    });

    expect(response.status).toBe('error');
    expect(response.content).toContain(sanitizedReference);
    expect(response.content).toContain('SDK diagnostic');
    expect(response.content).toContain('raw');
    expect(response.content).toContain('\\x01');
    expect(response.content).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/u);

    const streamedFailureEvents = events.filter((event) => event.type === 'error' || event.type === 'result');
    expect(streamedFailureEvents).toHaveLength(2);
    const streamedMessages = streamedFailureEvents.flatMap((event) => Object.values(event.data)
      .filter((value): value is string => typeof value === 'string'));
    expect(streamedMessages).not.toHaveLength(0);
    for (const message of streamedMessages) {
      expect(message).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/u);
    }
    expect(streamedMessages.some((message) => message.includes(sanitizedReference))).toBe(true);
    expect(streamedMessages.some((message) => message.includes('SDK diagnostic'))).toBe(true);
  });

  it('preserves runtime setup diagnostics for a routed model', async () => {
    const reference = 'known-route/runtime-unavailable-model';
    const response = await callDeepSeekHarness('worker', 'hello', {
      cwd: root,
      model: reference,
      providerOptions: { pythonPath, requestTimeoutMs: 10_000 },
    });

    expect(response.status).toBe('error');
    expect(response.content).toContain('Unable to start DeepSeek Harness Python bridge');
    expect(response.content).toContain('Install Python 3.10+ and deepseek-harness-sdk');
  });

  it('preserves multiple assistant messages when the SDK omits chunk events', async () => {
    const textEvents: string[] = [];
    const response = await callDeepSeekHarness('worker', 'message-events', {
      cwd: root,
      providerOptions: { pythonPath, requestTimeoutMs: 10_000 },
      onStream: (event) => {
        if (event.type === 'text') {
          textEvents.push(event.data.text);
        }
      },
    });

    expect(response).toMatchObject({ status: 'done', content: 'firstsecond' });
    expect(textEvents).toEqual(['first', 'second']);
  });

  it('redacts a DeepSeek API key from bridge failures', async () => {
    const secret = 'deepseek-test-secret-123';
    const response = await callDeepSeekHarness('worker', 'fail-secret', {
      cwd: root,
      childProcessEnv: { DEEPSEEK_API_KEY: secret },
      providerOptions: { pythonPath, requestTimeoutMs: 10_000 },
    });

    expect(response.status).toBe('error');
    expect(response.content).not.toContain(secret);
    expect(response.content).toContain('[REDACTED]');
  });

  it('redacts credentials from text, thinking, tool payloads, final output, and provider event logs', async () => {
    const secret = 'deepseek-output-secret-456';
    const logsDir = path.join(root, 'logs');
    await mkdir(logsDir);
    const logger = createProviderEventLogger({
      logsDir,
      sessionId: 'deepseek-output-session',
      runId: 'deepseek-output-run',
      enabled: true,
    });
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const response = await callDeepSeekHarness('worker', 'secret-events', {
      cwd: root,
      childProcessEnv: { DEEPSEEK_API_KEY: secret },
      providerOptions: { pythonPath, requestTimeoutMs: 10_000 },
      onStream: (event) => {
        events.push(event as { type: string; data: Record<string, unknown> });
        logger.logEvent({
          provider: 'deepseek-harness',
          providerModel: 'deepseek-v4-flash',
          step: 'smoke',
        }, event);
      },
    });
    const persisted = await readFile(logger.filepath, 'utf8');

    expect(response).toMatchObject({ status: 'done', content: '[REDACTED]' });
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(JSON.stringify(events)).toContain('[REDACTED]');
    expect(persisted).not.toContain(secret);
    expect(persisted).toContain('[REDACTED]');
  });

  it('rejects session identifiers that contain a known secret', async () => {
    const secret = 'deepseek-session-secret-789';
    const response = await callDeepSeekHarness('worker', 'hello', {
      cwd: root,
      sessionId: `session-${secret}`,
      childProcessEnv: { DEEPSEEK_API_KEY: secret },
      providerOptions: { pythonPath, requestTimeoutMs: 10_000 },
    });

    expect(response.status).toBe('error');
    expect(response.content).toContain('must not contain configured secret values');
    expect(response.sessionId).toBeUndefined();
  });

  it('rejects session identifiers containing credentials embedded in the configured base URL', async () => {
    const embeddedSecret = 'embedded-base-secret-012';
    const response = await callDeepSeekHarness('worker', 'hello', {
      cwd: root,
      sessionId: `session-${embeddedSecret}`,
      providerOptions: {
        pythonPath,
        baseUrl: `https://deepseek-user:${embeddedSecret}@deepseek.example/v1`,
        requestTimeoutMs: 10_000,
      },
    });

    expect(response.status).toBe('error');
    expect(response.content).toContain('must not contain configured secret values');
    expect(response.content).not.toContain(embeddedSecret);
    expect(response.sessionId).toBeUndefined();
  });

  it('rejects encoded URL-userinfo credentials in opaque session identifiers', async () => {
    const encodedUsername = 'embedded%40user';
    const encodedPassword = 'embedded%2Fpassword';
    const response = await callDeepSeekHarness('worker', 'hello', {
      cwd: root,
      sessionId: `session-${encodedUsername}`,
      providerOptions: {
        pythonPath,
        baseUrl: `https://${encodedUsername}:${encodedPassword}@deepseek.example/v1`,
        requestTimeoutMs: 10_000,
      },
    });

    expect(response.status).toBe('error');
    expect(response.content).toContain('must not contain configured secret values');
    expect(response.content).not.toContain(encodedUsername);
    expect(response.content).not.toContain(encodedPassword);
  });

  it('rejects tool identifiers that contain a configured secret', async () => {
    const secret = 'deepseek-tool-secret-345';
    const response = await callDeepSeekHarness('worker', 'secret-tool-id', {
      cwd: root,
      childProcessEnv: { DEEPSEEK_API_KEY: secret },
      providerOptions: { pythonPath, requestTimeoutMs: 10_000 },
    });

    expect(response.status).toBe('error');
    expect(response.content).toContain('tool ID must not contain configured secret values');
    expect(response.content).not.toContain(secret);
  });

  it.each([
    ['blocked', 'blocked', 'blocked'],
    ['max-tokens', 'error', 'maximum token limit'],
    ['interrupted', 'error', 'interrupted'],
    ['error', 'error', 'provider failure'],
  ] as const)('maps the official %s finish reason without reporting success', async (reason, status, message) => {
    const response = await callDeepSeekHarness('worker', `reason:${reason}`, {
      cwd: root,
      providerOptions: { pythonPath, requestTimeoutMs: 10_000 },
    });

    expect(response.status).toBe(status);
    expect(response.content).toContain(message);
    expect(response.status).not.toBe('done');
  });

  it('maps an SDK aborted finish reason to external_abort without reporting success', async () => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const response = await callDeepSeekHarness('worker', 'reason:aborted', {
      cwd: root,
      providerOptions: { pythonPath, requestTimeoutMs: 10_000 },
      onStream: (event) => events.push(event as { type: string; data: Record<string, unknown> }),
    });

    expect(response).toMatchObject({
      status: 'error',
      failureCategory: 'external_abort',
      error: response.content,
    });
    expect(response.content).toContain('DeepSeek Harness execution aborted');
    expect(response.content).not.toContain('provider bridge/SDK');
    expect(events).toEqual(expect.arrayContaining([
      { type: 'error', data: { message: response.content, raw: response.content } },
      expect.objectContaining({
        type: 'result',
        data: expect.objectContaining({
          error: response.content,
          success: false,
          failureCategory: 'external_abort',
        }),
      }),
    ]));
    expect(events.some((event) => event.type === 'result' && event.data.success === true)).toBe(false);
  });

  it.each([
    ['my-gateway/org/custom-model', 'my-gateway/org/custom-model'],
    [undefined, 'deepseek-v4-flash'],
  ] as const)('preserves structured provider error context for model %s', async (model, modelReference) => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const response = await callDeepSeekHarness('worker', 'reason:error', {
      cwd: root,
      ...(model === undefined ? {} : { model }),
      providerOptions: { pythonPath, requestTimeoutMs: 10_000 },
      onStream: (event) => events.push(event as { type: string; data: Record<string, unknown> }),
    });

    expect(response).toMatchObject({
      status: 'error',
      failureCategory: 'provider_error',
      error: response.content,
    });
    expect(response.content).toContain(modelReference);
    expect(response.content).toContain('provider bridge/SDK');
    expect(response.content).toContain('FAKE: provider failure');
    expect(events).toEqual(expect.arrayContaining([
      { type: 'error', data: { message: response.content, raw: response.content } },
      expect.objectContaining({
        type: 'result',
        data: expect.objectContaining({
          error: response.content,
          success: false,
          failureCategory: 'provider_error',
        }),
      }),
    ]));
    expect(events.some((event) => event.type === 'result' && event.data.success === true)).toBe(false);
  });

  it('rejects an unknown finish reason as a provider stream protocol error', async () => {
    const response = await callDeepSeekHarness('worker', 'reason:future-reason', {
      cwd: root,
      providerOptions: { pythonPath, requestTimeoutMs: 10_000 },
    });

    expect(response.status).toBe('error');
    expect(response.failureCategory).toBe('provider_stream_parse_error');
    expect(response.content).toContain('unsupported turn completion reason');
  });

  it('returns a provider error when SDK startup fails', async () => {
    const response = await callDeepSeekHarness('worker', 'hello', {
      cwd: root,
      providerOptions: {
        pythonPath,
        cordis: 'FAKE_START_FAILURE',
        requestTimeoutMs: 10_000,
      },
    });

    expect(response.status).toBe('error');
    expect(response.failureCategory).toBe('provider_error');
    expect(response.content).toContain('startup failure');
  });

  it('keeps SDK stdout noise off the bridge protocol stream', async () => {
    const response = await callDeepSeekHarness('worker', 'malformed-json', {
      cwd: root,
      providerOptions: { pythonPath, requestTimeoutMs: 10_000 },
    });

    expect(response).toMatchObject({ status: 'done', content: 'hello' });
  });

  it('maps malformed JSON bridge output to a stream protocol error', async () => {
    const response = await callDeepSeekHarness('worker', 'malformed-frame', {
      cwd: root,
      providerOptions: { pythonPath, requestTimeoutMs: 10_000 },
    });

    expect(response.status).toBe('error');
    expect(response.failureCategory).toBe('provider_stream_parse_error');
    expect(response.content).toContain('malformed JSON');
  });

  it('maps a malformed notification frame to a stream protocol error', async () => {
    const response = await callDeepSeekHarness('worker', 'malformed-notification', {
      cwd: root,
      providerOptions: { pythonPath, requestTimeoutMs: 10_000 },
    });

    expect(response.status).toBe('error');
    expect(response.failureCategory).toBe('provider_stream_parse_error');
    expect(response.content).toContain('malformed assistant chunk');
  });

  it('serializes concurrent SDK notifications without corrupting JSONL frames', async () => {
    const response = await callDeepSeekHarness('worker', 'concurrent-events', {
      cwd: root,
      providerOptions: { pythonPath, requestTimeoutMs: 10_000 },
    });

    expect(response).toMatchObject({ status: 'done', content: 'hello' });
  });

  it.each(['missing-turn-end', 'missing-result-reason', 'mismatched-reason'] as const)(
    'rejects %s when the bridge result and turn end reason do not match',
    async (input) => {
      const response = await callDeepSeekHarness('worker', input, {
        cwd: root,
        providerOptions: { pythonPath, requestTimeoutMs: 10_000 },
      });

      expect(response.status).toBe('error');
      expect(response.failureCategory).toBe('provider_stream_parse_error');
      expect(response.content).toContain('finishReason did not match');
    },
  );

  it('preserves credential-like and known-secret prompt text', async () => {
    const secret = 'prompt-secret-789';
    const prompt = `capture-prompt: preserve DEEPSEEK_API_KEY=${secret} exactly`;
    const response = await callDeepSeekHarness('worker', prompt, {
      cwd: root,
      childProcessEnv: { DEEPSEEK_API_KEY: secret },
      providerOptions: { pythonPath, requestTimeoutMs: 10_000 },
    });

    expect(response.status).toBe('done');
    expect(await readFile(path.join(root, 'received-prompt.txt'), 'utf8')).toBe(prompt);
  });

  it('isolates bridge credentials from unrelated child environment variables', async () => {
    const response = await callDeepSeekHarness('worker', 'inspect-env', {
      cwd: root,
      childProcessEnv: {
        DEEPSEEK_API_KEY: 'deepseek-env-secret',
        DEEPSEEK_BASE_URL: 'https://deepseek.example/v1',
        OPENAI_API_KEY: 'unrelated-secret',
        TAKT_OBSERVABILITY_ENABLED: '1',
        HOME: 'unrelated-home',
        DSH_RUNTIME_MODE: 'node',
      },
      providerOptions: { pythonPath, requestTimeoutMs: 10_000 },
    });
    const bridgeEnvironment = JSON.parse(await readFile(path.join(root, 'bridge-env.json'), 'utf8')) as Record<string, string | null>;

    expect(response.status).toBe('done');
    expect(bridgeEnvironment.DEEPSEEK_API_KEY).toBe('deepseek-env-secret');
    expect(bridgeEnvironment.DEEPSEEK_BASE_URL).toBe('https://deepseek.example/v1');
    expect(bridgeEnvironment.TAKT_OBSERVABILITY_ENABLED).toBe('1');
    expect(Object.prototype.hasOwnProperty.call(bridgeEnvironment, 'OPENAI_API_KEY')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(bridgeEnvironment, 'HOME')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(bridgeEnvironment, 'DSH_RUNTIME_MODE')).toBe(false);
  });

  it('maps an SDK JSON-RPC failure to a provider error', async () => {
    const response = await callDeepSeekHarness('worker', 'jsonrpc-failure', {
      cwd: root,
      providerOptions: { pythonPath, requestTimeoutMs: 10_000 },
    });

    expect(response.status).toBe('error');
    expect(response.failureCategory).toBe('provider_error');
    expect(response.content).toContain('jsonrpc failure');
  });

  it('maps an unexpected bridge exit to a provider error without hanging', async () => {
    const response = await callDeepSeekHarness('worker', 'unexpected-exit', {
      cwd: root,
      providerOptions: { pythonPath, requestTimeoutMs: 10_000 },
    });

    expect(response.status).toBe('error');
    expect(response.failureCategory).toBe('provider_error');
    expect(response.content).toMatch(/process exited|stdout closed/u);
  });

  it.each(['', '.', '..', '../outside', 'nested/session', 'C:\\outside'] as const)(
    'rejects path-like session IDs before starting the bridge: %s',
    async (sessionId) => {
      const response = await callDeepSeekHarness('worker', 'hello', {
        cwd: root,
        sessionId,
        providerOptions: { pythonPath, requestTimeoutMs: 10_000 },
      });

      expect(response.status).toBe('error');
      expect(response.content).toContain('path-safe identifier');
    },
  );

  it('reuses one Python bridge for repeated calls with the same session', async () => {
    const counterFile = path.join(root, 'bridge-starts.txt');
    const first = await callDeepSeekHarness('worker', 'hello', {
      cwd: root,
      sessionId: 'persistent-session',
      providerOptions: { pythonPath, sessionRoot: counterFile, requestTimeoutMs: 10_000 },
    });
    const second = await callDeepSeekHarness('worker', 'hello', {
      cwd: root,
      sessionId: 'persistent-session',
      providerOptions: { pythonPath, sessionRoot: counterFile, requestTimeoutMs: 10_000 },
    });

    expect(first).toMatchObject({ status: 'done', sessionId: 'persistent-session' });
    expect(second).toMatchObject({ status: 'done', sessionId: 'persistent-session' });
    expect((await readFile(counterFile, 'utf8')).trim().split('\n')).toEqual(['initialized']);
  });

  it('reuses one process when bare and explicit default routes have the same effective identity', async () => {
    const counterFile = path.join(root, 'default-route-starts.txt');
    const first = await callDeepSeekHarness('worker', 'hello', {
      cwd: root,
      model: 'deepseek-v4-flash',
      sessionId: 'default-route-session',
      providerOptions: { pythonPath, sessionRoot: counterFile, requestTimeoutMs: 10_000 },
    });
    const second = await callDeepSeekHarness('worker', 'hello', {
      cwd: root,
      model: 'deepseek-official/deepseek-v4-flash',
      sessionId: 'default-route-session',
      providerOptions: { pythonPath, sessionRoot: counterFile, requestTimeoutMs: 10_000 },
    });

    expect(first.status).toBe('done');
    expect(second.status).toBe('done');
    expect((await readFile(counterFile, 'utf8')).trim().split('\n')).toEqual(['initialized']);
  });

  it('does not share a process when the effective route or model changes', async () => {
    const counterFile = path.join(root, 'routing-starts.txt');
    const calls = [
      ['route-a-session', 'openai/gpt-5.4'],
      ['model-b-session', 'openai/gpt-5.5'],
      ['route-b-session', 'anthropic/gpt-5.4'],
    ] as const;

    for (const [sessionId, model] of calls) {
      const response = await callDeepSeekHarness('worker', 'hello', {
        cwd: root,
        model,
        sessionId,
        providerOptions: { pythonPath, sessionRoot: counterFile, requestTimeoutMs: 10_000 },
      });
      expect(response.status).toBe('done');
    }

    expect((await readFile(counterFile, 'utf8')).trim().split('\n')).toEqual([
      'initialized',
      'initialized',
      'initialized',
    ]);
  });

  it('rejects a relative session root that traverses a symlink outside the project', async () => {
    const outsideRoot = await mkdtemp(path.join(os.tmpdir(), 'takt-deepseek-harness-outside-'));
    try {
      const outsideSessionFile = path.join(outsideRoot, 'session.db');
      const linkedSessionFile = path.join(root, 'session-link');
      await writeFile(outsideSessionFile, 'outside\n', 'utf8');
      await symlink(outsideSessionFile, linkedSessionFile, 'file');

      const response = await callDeepSeekHarness('worker', 'hello', {
        cwd: root,
        providerOptions: {
          pythonPath,
          sessionRoot: 'session-link',
          requestTimeoutMs: 10_000,
        },
      });

      expect(response.status).toBe('error');
      expect(response.content).toContain('session_root');
      expect(response.content).toContain('symlinks');
      expect(await readFile(outsideSessionFile, 'utf8')).toBe('outside\n');
    } finally {
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it('rejects a relative Cordis path that traverses a symlink outside the project', async () => {
    const outsideRoot = await mkdtemp(path.join(os.tmpdir(), 'takt-deepseek-harness-outside-'));
    try {
      const outsideCordis = path.join(outsideRoot, 'cordis.yml');
      const linkedCordis = path.join(root, 'cordis-link.yml');
      await writeFile(outsideCordis, 'outside\n', 'utf8');
      await symlink(outsideCordis, linkedCordis, 'file');

      const response = await callDeepSeekHarness('worker', 'hello', {
        cwd: root,
        providerOptions: {
          pythonPath,
          cordis: 'cordis-link.yml',
          requestTimeoutMs: 10_000,
        },
      });

      expect(response.status).toBe('error');
      expect(response.content).toContain('cordis');
      expect(await readFile(outsideCordis, 'utf8')).toBe('outside\n');
    } finally {
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it('reuses a session through canonical project and session-root aliases', async () => {
    const aliasContainer = await mkdtemp(path.join(os.tmpdir(), 'takt-deepseek-harness-alias-'));
    try {
      const sharedSessionFile = path.join(root, 'same-project-session.db');
      const projectAlias = path.join(aliasContainer, 'project-alias');
      const aliasedSessionFile = path.join(aliasContainer, 'same-project-session-alias.db');
      await writeFile(sharedSessionFile, '', 'utf8');
      await symlink(root, projectAlias, 'dir');
      await symlink(sharedSessionFile, aliasedSessionFile, 'file');

      const first = await callDeepSeekHarness('worker', 'hello', {
        cwd: root,
        sessionId: 'canonical-alias-session',
        providerOptions: {
          pythonPath,
          sessionRoot: sharedSessionFile,
          requestTimeoutMs: 10_000,
        },
      });
      const second = await callDeepSeekHarness('worker', 'hello', {
        cwd: projectAlias,
        sessionId: 'canonical-alias-session',
        providerOptions: {
          pythonPath,
          sessionRoot: aliasedSessionFile,
          requestTimeoutMs: 10_000,
        },
      });

      expect(first).toMatchObject({ status: 'done', sessionId: 'canonical-alias-session' });
      expect(second).toMatchObject({ status: 'done', sessionId: 'canonical-alias-session' });
      expect((await readFile(sharedSessionFile, 'utf8')).trim().split('\n')).toEqual(['initialized']);
    } finally {
      await rm(aliasContainer, { recursive: true, force: true });
    }
  });

  it('canonicalizes session root aliases before cross-project binding checks', async () => {
    const otherRoot = await mkdtemp(path.join(os.tmpdir(), 'takt-deepseek-harness-other-'));
    try {
      const sharedSessionFile = path.join(root, 'shared-session.db');
      const aliasedSessionFile = path.join(otherRoot, 'shared-session-alias.db');
      await writeFile(sharedSessionFile, '', 'utf8');
      await symlink(sharedSessionFile, aliasedSessionFile, 'file');

      const first = await callDeepSeekHarness('worker', 'hello', {
        cwd: root,
        sessionId: 'shared-root-owner',
        providerOptions: {
          pythonPath,
          sessionRoot: sharedSessionFile,
          requestTimeoutMs: 10_000,
        },
      });
      const second = await callDeepSeekHarness('worker', 'hello', {
        cwd: otherRoot,
        sessionId: 'different-project',
        providerOptions: {
          pythonPath,
          sessionRoot: aliasedSessionFile,
          requestTimeoutMs: 10_000,
        },
      });

      expect(first.status).toBe('done');
      expect(second.status).toBe('error');
      expect(second.content).toContain('different project');
      expect((await readFile(sharedSessionFile, 'utf8')).trim().split('\n')).toEqual(['initialized']);
    } finally {
      await rm(otherRoot, { recursive: true, force: true });
    }
  });

  it('rejects reusing a closed one-shot session root from another project', async () => {
    const otherRoot = await mkdtemp(path.join(os.tmpdir(), 'takt-deepseek-harness-other-'));
    try {
      const sessionRoot = path.join(root, 'shared-one-shot-sessions');
      const first = await callDeepSeekHarness('worker', 'hello', {
        cwd: root,
        providerOptions: { pythonPath, sessionRoot, requestTimeoutMs: 10_000 },
      });
      const second = await callDeepSeekHarness('worker', 'hello', {
        cwd: otherRoot,
        providerOptions: { pythonPath, sessionRoot, requestTimeoutMs: 10_000 },
      });

      expect(first.status).toBe('done');
      expect(second.status).toBe('error');
      expect(second.content).toContain('different project');
    } finally {
      await rm(otherRoot, { recursive: true, force: true });
    }
  });

  it('rejects reusing a session root and session id from another project', async () => {
    const otherRoot = await mkdtemp(path.join(os.tmpdir(), 'takt-deepseek-harness-other-'));
    try {
      const sessionRoot = path.join(root, 'shared-sessions.txt');
      const first = await callDeepSeekHarness('worker', 'hello', {
        cwd: root,
        sessionId: 'cross-project-session',
        providerOptions: { pythonPath, sessionRoot, requestTimeoutMs: 10_000 },
      });
      const second = await callDeepSeekHarness('worker', 'hello', {
        cwd: otherRoot,
        sessionId: 'cross-project-session',
        providerOptions: { pythonPath, sessionRoot, requestTimeoutMs: 10_000 },
      });

      expect(first.status).toBe('done');
      expect(second.status).toBe('error');
      expect(second.content).toContain('different project');
    } finally {
      await rm(otherRoot, { recursive: true, force: true });
    }
  });

  it('maps a request timeout to a bounded part-timeout failure and closes the bridge', async () => {
    const startedAt = Date.now();
    const response = await callDeepSeekHarness('worker', 'hang', {
      cwd: root,
      providerOptions: {
        pythonPath,
        requestTimeoutMs: 100,
      },
    });

    expect(response.status).toBe('error');
    expect(response.failureCategory).toBe('part_timeout');
    expect(response.content).toContain('timed out');
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it('terminates a bridge that does not answer the close request', async () => {
    const startedAt = Date.now();
    const response = await callDeepSeekHarness('worker', 'hello', {
      cwd: root,
      providerOptions: {
        pythonPath,
        cordis: 'FAKE_CLOSE_HANG',
        requestTimeoutMs: 10_000,
        shutdownTimeoutMs: 100,
      },
    });

    expect(response.status).toBe('done');
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it('terminates the Python bridge when the caller aborts a running SDK turn', async () => {
    const controller = new AbortController();
    const startedAt = Date.now();
    const call = callDeepSeekHarness('worker', 'hang', {
      cwd: root,
      abortSignal: controller.signal,
      providerOptions: { pythonPath, requestTimeoutMs: 10_000 },
    });
    setTimeout(() => controller.abort(new Error('cancelled by test')), 100).unref();

    const response = await call;
    expect(response.status).toBe('error');
    expect(response.failureCategory).toBe('external_abort');
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  });
});
