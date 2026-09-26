import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProviderEventLogger } from '../core/logging/providerEventLogger.js';
import { renderTraceReportFromRecords } from '../features/tasks/execute/traceReport.js';
import {
  callDeepSeekHarness,
  closeDeepSeekHarnessProcesses,
} from '../infra/deepseek-harness/index.js';
import { createSessionDispatchQueue } from '../infra/deepseek-harness/session-dispatch.js';
import {
  DEEPSEEK_HARNESS_RUNTIME_VERSION,
  DEEPSEEK_HARNESS_SDK_VERSION,
} from '../infra/deepseek-harness/constants.js';
import type { DeepSeekHarnessProviderOptions } from '../core/models/workflow-provider-options.js';

function isSupportedPythonVersion(version: readonly [number, number]): boolean {
  const minimum: readonly [number, number] = [3, 10];
  return version[0] > minimum[0]
    || (version[0] === minimum[0] && version[1] >= minimum[1]);
}

function findPython(candidates: readonly string[]): string | undefined {
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

function findLifecyclePython(): string | undefined {
  const candidates = process.platform === 'win32' ? ['python'] : ['python3', 'python'];
  return findPython(candidates);
}

interface BridgePatchEntry {
  path: string;
  content: string;
}

async function readBridgePatches(workspace: string): Promise<BridgePatchEntry[]> {
  try {
    const content = await readFile(path.join(workspace, 'bridge-patches.jsonl'), 'utf8');
    return content.trim().split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as BridgePatchEntry);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

async function writeSourceSettings(sourceHome: string, content: string): Promise<void> {
  await mkdir(sourceHome, { recursive: true });
  await writeFile(path.join(sourceHome, 'settings.yaml'), content, 'utf8');
}

const supportedPlatform = (
  (process.platform === 'linux' && (process.arch === 'x64' || process.arch === 'arm64'))
  || (process.platform === 'darwin' && process.arch === 'arm64')
);
const lifecycleRuntimeSupported = supportedPlatform && findLifecyclePython() !== undefined;

it.skipIf(supportedPlatform)('DeepSeek Harness fails fast with an actionable unsupported-platform error', async () => {
  const response = await callDeepSeekHarness('worker', 'hello', { cwd: process.cwd() });

  expect(response.status).toBe('error');
  expect(response.content).toContain('Linux x64/arm64 or macOS arm64');
});

describe.skipIf(!lifecycleRuntimeSupported)('DeepSeek Harness bridge lifecycle', () => {
  let root: string;
  let globalConfigDir: string;
  let managedPythonPath: string;
  let sourceHome: string;

  beforeEach(async () => {
    const python = findLifecyclePython();
    if (python === undefined) {
      throw new Error('Python 3.10+ was detected during suite selection but is unavailable');
    }
    root = await mkdtemp(path.join(os.tmpdir(), 'takt-deepseek-harness-'));
    globalConfigDir = path.join(root, 'global');
    managedPythonPath = path.join(
      globalConfigDir,
      'deepseek-harness',
      'venv',
      process.platform === 'win32' ? 'Scripts' : 'bin',
      process.platform === 'win32' ? 'python.exe' : 'python',
    );
    sourceHome = path.join(root, 'credential-source-home');
    vi.stubEnv('TAKT_CONFIG_DIR', globalConfigDir);
    vi.stubEnv('DSH_HOME', sourceHome);
    const moduleDir = path.join(root, 'deepseek_harness');
    await mkdir(moduleDir);
    await writeFile(path.join(moduleDir, '__init__.py'), `
import json
import os
import sys
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

class DeepSeekHarnessConfig:
    def __init__(self, provider, model, cwd, runtime_cwd, max_tokens=None, request_timeout_seconds=None, shutdown_timeout_seconds=None, reasoning_effort=None, patches=None):
        kwargs = {
            'provider': provider,
            'model': model,
            'cwd': cwd,
            'runtime_cwd': runtime_cwd,
            'max_tokens': max_tokens,
            'request_timeout_seconds': request_timeout_seconds,
            'shutdown_timeout_seconds': shutdown_timeout_seconds,
        }
        if reasoning_effort is not None:
            if reasoning_effort not in ('off', 'low', 'high', 'max'):
                raise ValueError('unsupported reasoning_effort')
            kwargs['reasoning_effort'] = reasoning_effort
        if patches is not None:
            kwargs['patches'] = [str(patch) for patch in patches]
        self.kwargs = kwargs

class DeepSeekHarness:
    def __init__(self, **kwargs):
        self.config = DeepSeekHarnessConfig(**kwargs)
        kwargs = self.config.kwargs
        self.kwargs = kwargs
        self.closed = False
        if sys.argv[0] != '-c':
            config_file = os.path.join(kwargs['cwd'], 'bridge-start-configs.jsonl')
            with open(config_file, 'a', encoding='utf-8') as config:
                config.write(json.dumps(kwargs, sort_keys=True) + '\\n')
            patch_paths = kwargs.get('patches') or []
            if patch_paths:
                patches_file = os.path.join(kwargs['cwd'], 'bridge-patches.jsonl')
                with open(patches_file, 'a', encoding='utf-8') as patches_log:
                    for patch_path in patch_paths:
                        with open(patch_path, encoding='utf-8') as patch_stream:
                            patches_log.write(json.dumps({'path': patch_path, 'content': patch_stream.read()}, sort_keys=True) + '\\n')
        if kwargs.get('reasoning_effort') == 'max' and sys.argv[0] != '-c' and os.path.exists(${JSON.stringify(path.join(root, 'fail-max-effort'))}):
            raise RuntimeError('reasoning effort process startup failure')
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
    def start(self):
        if self.kwargs.get('model') == 'start-failure-model':
            raise RuntimeError('startup failure')

    def close(self):
        if self.kwargs.get('shutdown_timeout_seconds') == 0.1:
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
        if input == 'block-turn':
            with open(${JSON.stringify(path.join(root, 'turn-started.marker'))}, 'w', encoding='utf-8') as marker:
                marker.write('started\\n')
            while not os.path.exists(${JSON.stringify(path.join(root, 'turn-release.marker'))}):
                time.sleep(0.01)
        if input == 'mark-turn-start':
            with open(${JSON.stringify(path.join(root, 'third-turn-started.marker'))}, 'w', encoding='utf-8') as marker:
                marker.write('started\\n')
        if input == 'fail-secret':
            raise RuntimeError(os.environ.get('DEEPSEEK_API_KEY', 'missing-secret'))
        if input == 'fail-custom-ref':
            raise RuntimeError(os.environ.get('CUSTOM_DSH_KEY', 'missing-custom-ref'))
        if input == 'unknown-store-failure':
            print('stderr-only-store-secret', file=sys.stderr, flush=True)
            raise RuntimeError('unclassified-store-secret nested-cause-secret')
        if input == 'unknown-store-exit':
            print('stderr-only-store-secret', file=sys.stderr, flush=True)
            os._exit(23)
        if input == 'malformed-json':
            print('not-json', flush=True)
        if input == 'jsonrpc-failure':
            raise JsonRpcError('jsonrpc failure')
        if input == 'unexpected-exit':
            os._exit(23)
        active_session = session_id or 'generated-session'
        history_path = os.path.join(os.environ['DSH_HOME'], 'session-history.jsonl')
        with open(history_path, 'a', encoding='utf-8') as history_file:
            history_file.write(json.dumps({
                'sessionId': active_session,
                'prompt': input,
                'reasoning_effort': self.kwargs.get('reasoning_effort'),
            }, sort_keys=True) + '\\n')
        if input.startswith('capture-prompt:'):
            with open(os.path.join(self.kwargs['cwd'], 'received-prompt.txt'), 'w', encoding='utf-8') as prompt_file:
                prompt_file.write(input)
        if input == 'inspect-env':
            environment = {}
            for name in ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'CUSTOM_DSH_KEY', 'OPENAI_API_KEY', 'TAKT_OBSERVABILITY_ENABLED', 'HOME', 'DSH_RUNTIME_MODE']:
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
        if input.startswith('typed-stream:'):
            events = [
                {'type': 'assistant/chunk', 'data': {'chunk': {'type': kind, 'text': value}}}
                for kind, value in json.loads(input.split(':', 1)[1])
            ] + [{'type': 'turn/end', 'data': {'reason': {'kind': 'completed'}}}]
        if input == 'split-secret-events':
            midpoint = len(secret) // 2
            events = [
                {'type': 'assistant/chunk', 'data': {'chunk': {'type': 'reasoning-delta', 'text': secret[:midpoint]}}},
                {'type': 'assistant/chunk', 'data': {'chunk': {'type': 'reasoning-delta', 'text': secret[midpoint:]}}},
                {'type': 'tool/call', 'data': {'callId': 'call-split', 'name': 'read', 'arguments': tool_arguments}},
                {'type': 'tool/result', 'data': {'message': {'source': {'callId': 'call-split'}, 'content': [{'type': 'tool-result', 'toolCallId': 'call-split', 'content': [{'type': 'text', 'text': secret}]}]}}},
                {'type': 'assistant/chunk', 'data': {'chunk': {'type': 'text-delta', 'text': secret[:midpoint]}}},
                {'type': 'assistant/chunk', 'data': {'chunk': {'type': 'text-delta', 'text': secret[midpoint:]}}},
                {'type': 'turn/end', 'data': {'reason': {'kind': 'completed'}}},
            ]
        if input == 'safe-credential-boundary':
            events = [
                {'type': 'assistant/chunk', 'data': {'chunk': {'type': 'text-delta', 'text': 'api_key=provider-config'}}},
                {'type': 'turn/end', 'data': {'reason': {'kind': 'completed'}}},
            ]
        if input == 'pending-secret':
            events = [
                {'type': 'assistant/chunk', 'data': {'chunk': {'type': 'text-delta', 'text': secret[:-1]}}},
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
        final_response = 'firstsecond' if input == 'message-events' else (secret if secret_events or input == 'split-secret-events' else 'hello')
        if input == 'empty-response':
            final_response = ''
        return Result(active_session, final_response, result_finish_reason)
`, 'utf8');
    await writeFile(path.join(root, 'sitecustomize.py'), `
import os
import sys
import time
import types

if sys.argv and sys.argv[0] == '-c' and os.environ.get('FAKE_PROBE_HANG') == '1':
    with open(${JSON.stringify(path.join(root, 'probe-started.marker'))}, 'w', encoding='utf-8') as marker:
        marker.write(str(os.getpid()) + '\\n')
    while not os.path.exists(${JSON.stringify(path.join(root, 'probe-release'))}):
        time.sleep(0.01)

VersionInfo = type('VersionInfo', (tuple,), {
    'major': property(lambda self: self[0]),
    'minor': property(lambda self: self[1]),
    'micro': property(lambda self: self[2]),
})
sys.version_info = VersionInfo((3, 12, 9, 'final', 0))
sys.implementation = types.SimpleNamespace(
    name='cpython',
    cache_tag='cpython-312',
    version=sys.version_info,
    hexversion=0x30C0000,
    _multiarch='test',
)
`, 'utf8');
    const sdkInfoDir = path.join(root, `deepseek_harness_sdk-${DEEPSEEK_HARNESS_SDK_VERSION}.dist-info`);
    const runtimeInfoDir = path.join(root, `deepseek_harness_runtime_bin-${DEEPSEEK_HARNESS_RUNTIME_VERSION}.dist-info`);
    await mkdir(sdkInfoDir, { recursive: true });
    await mkdir(runtimeInfoDir, { recursive: true });
    await writeFile(path.join(sdkInfoDir, 'METADATA'), [
      'Metadata-Version: 2.1',
      'Name: deepseek-harness-sdk',
      `Version: ${DEEPSEEK_HARNESS_SDK_VERSION}`,
      'Requires-Python: >=3.12,<3.13',
      `Requires-Dist: deepseek-harness-runtime-bin==${DEEPSEEK_HARNESS_RUNTIME_VERSION}`,
      '',
    ].join('\n'), 'utf8');
    await writeFile(path.join(runtimeInfoDir, 'METADATA'), [
      'Metadata-Version: 2.1',
      'Name: deepseek-harness-runtime-bin',
      `Version: ${DEEPSEEK_HARNESS_RUNTIME_VERSION}`,
      '',
    ].join('\n'), 'utf8');
    await mkdir(path.dirname(managedPythonPath), { recursive: true });
    await mkdir(path.join(globalConfigDir, 'deepseek-harness', 'dsh-home'), { recursive: true });
    await writeFile(managedPythonPath, `#!/bin/sh\nPYTHONPATH="${root}:${'${PYTHONPATH:-}'}" exec "${python}" "$@"\n`, 'utf8');
    await chmod(managedPythonPath, 0o755);
  });

  afterEach(async () => {
    await closeDeepSeekHarnessProcesses();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it('converts official SDK notifications and closes one-shot sessions', async () => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const response = await callDeepSeekHarness('worker', 'hello', {
      cwd: root,
      providerOptions: {
        requestTimeoutMs: 10_000,
      },
      onStream: (event) => events.push(event as unknown as { type: string; data: Record<string, unknown> }),
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
    expect(configuration).not.toHaveProperty('reasoning_effort');
  });

  it.each(['off', 'low', 'high', 'max'] as const)('passes reasoning_effort=%s to the SDK constructor', async (reasoningEffort) => {
    const providerOptions = {
      requestTimeoutMs: 10_000,
      reasoningEffort,
    } satisfies DeepSeekHarnessProviderOptions;
    const response = await callDeepSeekHarness('worker', 'hello', {
      cwd: root,
      providerOptions,
    });

    const [configuration] = (await readFile(path.join(root, 'bridge-start-configs.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(response.status).toBe('done');
    expect(configuration).toMatchObject({ reasoning_effort: reasoningEffort });
  });

  it('keeps the effort captured for a running turn when the caller mutates its options', async () => {
    const providerOptions: DeepSeekHarnessProviderOptions = {
      requestTimeoutMs: 10_000,
      reasoningEffort: 'high',
    };
    const pending = callDeepSeekHarness('worker', 'hello', {
      cwd: root,
      providerOptions,
    });
    providerOptions.reasoningEffort = 'max';
    const response = await pending;

    const [configuration] = (await readFile(path.join(root, 'bridge-start-configs.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(response.status).toBe('done');
    expect(configuration).toMatchObject({ reasoning_effort: 'high' });
  });

  it('keeps queued turn options captured before the session dispatch waits', async () => {
    const first = callDeepSeekHarness('worker', 'block-turn', {
      cwd: root,
      sessionId: 'queued-mutation-session',
      providerOptions: {
        requestTimeoutMs: 10_000,
        reasoningEffort: 'high',
      },
    });
    await vi.waitFor(async () => {
      await expect(readFile(path.join(root, 'turn-started.marker'), 'utf8')).resolves.toContain('started');
    });

    const secondProviderOptions: DeepSeekHarnessProviderOptions = {
      requestTimeoutMs: 10_000,
      reasoningEffort: 'max',
    };
    const second = callDeepSeekHarness('worker', 'queued-turn', {
      cwd: root,
      sessionId: 'queued-mutation-session',
      providerOptions: secondProviderOptions,
    });
    secondProviderOptions.reasoningEffort = 'low';
    await writeFile(path.join(root, 'turn-release.marker'), '', 'utf8');

    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    expect(firstResponse).toMatchObject({ status: 'done', sessionId: 'queued-mutation-session' });
    expect(secondResponse).toMatchObject({ status: 'done', sessionId: 'queued-mutation-session' });

    const configurations = (await readFile(path.join(root, 'bridge-start-configs.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(configurations.map((configuration) => configuration.reasoning_effort))
      .toEqual(['high', 'max']);

    const history = (await readFile(path.join(root, 'global', 'deepseek-harness', 'dsh-home', 'session-history.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(history).toEqual([
      { prompt: 'block-turn', reasoning_effort: 'high', sessionId: 'queued-mutation-session' },
      { prompt: 'queued-turn', reasoning_effort: 'max', sessionId: 'queued-mutation-session' },
    ]);
  });

  it('aborts a session turn while it is waiting for the previous turn', async () => {
    const first = callDeepSeekHarness('worker', 'block-turn', {
      cwd: root,
      sessionId: 'queued-abort-session',
      providerOptions: { requestTimeoutMs: 10_000 },
    });
    await vi.waitFor(async () => {
      await expect(readFile(path.join(root, 'turn-started.marker'), 'utf8')).resolves.toContain('started');
    });

    const controller = new AbortController();
    const second = callDeepSeekHarness('worker', 'queued-turn', {
      cwd: root,
      sessionId: 'queued-abort-session',
      abortSignal: controller.signal,
      providerOptions: { requestTimeoutMs: 10_000 },
    });
    controller.abort(new Error('cancelled while waiting for session dispatch'));

    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const secondResponse = await Promise.race([
        second,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('queued session abort was not observed')), 1_000);
        }),
      ]);
      expect(secondResponse).toMatchObject({
        status: 'error',
        failureCategory: 'external_abort',
      });
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      await writeFile(path.join(root, 'turn-release.marker'), '', 'utf8');
    }

    await expect(first).resolves.toMatchObject({ status: 'done', sessionId: 'queued-abort-session' });
    const history = (await readFile(path.join(root, 'global', 'deepseek-harness', 'dsh-home', 'session-history.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(history).toEqual([
      { prompt: 'block-turn', reasoning_effort: null, sessionId: 'queued-abort-session' },
    ]);
  });

  it('keeps a session tail until the preceding turn completes after a queued abort', async () => {
    const first = callDeepSeekHarness('worker', 'block-turn', {
      cwd: root,
      sessionId: 'queued-abort-order-session',
      providerOptions: { requestTimeoutMs: 10_000 },
    });
    await vi.waitFor(async () => {
      await expect(readFile(path.join(root, 'turn-started.marker'), 'utf8')).resolves.toContain('started');
    });

    const controller = new AbortController();
    const second = callDeepSeekHarness('worker', 'queued-turn', {
      cwd: root,
      sessionId: 'queued-abort-order-session',
      abortSignal: controller.signal,
      providerOptions: { requestTimeoutMs: 10_000 },
    });
    const third = callDeepSeekHarness('worker', 'mark-turn-start', {
      cwd: root,
      sessionId: 'queued-abort-order-session',
      providerOptions: { requestTimeoutMs: 10_000 },
    });
    controller.abort(new Error('cancelled while waiting for session dispatch'));

    await expect(second).resolves.toMatchObject({
      status: 'error',
      failureCategory: 'external_abort',
    });
    await expect(readFile(path.join(root, 'third-turn-started.marker'), 'utf8')).rejects.toThrow();

    await writeFile(path.join(root, 'turn-release.marker'), '', 'utf8');
    await expect(first).resolves.toMatchObject({ status: 'done', sessionId: 'queued-abort-order-session' });
    await expect(third).resolves.toMatchObject({ status: 'done', sessionId: 'queued-abort-order-session' });
    await expect(readFile(path.join(root, 'third-turn-started.marker'), 'utf8')).resolves.toContain('started');
  });

  it('propagates all DeepSeek provider options to the SDK and bridge environment', async () => {
    const baseUrl = 'https://deepseek.example/v1';
    const responses: Array<Awaited<ReturnType<typeof callDeepSeekHarness>>> = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      responses.push(await callDeepSeekHarness('worker', 'inspect-env', {
        cwd: root,
        model: 'openai/gpt-5.4',
        providerOptions: {
          baseUrl,
          maxTokens: 4096,
          requestTimeoutMs: 120_000,
          shutdownTimeoutMs: 2_000,
          runtimeMode: 'node',
        },
      }));
    }
    const [configuration] = (await readFile(path.join(root, 'bridge-start-configs.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const bridgeEnvironment = JSON.parse(await readFile(path.join(root, 'bridge-env.json'), 'utf8')) as Record<string, string>;

    expect(responses.map((response) => response.status)).toEqual(['done', 'done']);
    expect(configuration).toMatchObject({
      provider: 'openai',
      model: 'gpt-5.4',
      cwd: root,
      runtime_cwd: root,
      max_tokens: 4096,
      request_timeout_seconds: 120,
      shutdown_timeout_seconds: 2,
    });
    expect(configuration).not.toHaveProperty('session_root');
    expect(configuration).not.toHaveProperty('cordis');
    expect((await readFile(path.join(root, 'bridge-start-configs.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>))
      .toHaveLength(2);
    expect(bridgeEnvironment).toMatchObject({
      DEEPSEEK_BASE_URL: baseUrl,
      DSH_RUNTIME_MODE: 'node',
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
      providerOptions: { requestTimeoutMs: 10_000 },
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
      providerOptions: { requestTimeoutMs: 10_000 },
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
  ] as const)('withholds unclassified bridge/SDK details for %s', async (reference, provider, modelId, sdkFailure) => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const response = await callDeepSeekHarness('worker', 'hello', {
      cwd: root,
      model: reference,
      providerOptions: { requestTimeoutMs: 10_000 },
      onStream: (event) => events.push(event as unknown as { type: string; data: Record<string, unknown> }),
    });
    const [configuration] = (await readFile(path.join(root, 'bridge-start-configs.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(response.status).toBe('error');
    expect(configuration).toMatchObject({ provider, model: modelId });
    expect(response.content).toContain('Upstream error details are withheld');
    expect(response.content).not.toContain(sdkFailure);
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
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const response = await callDeepSeekHarness('worker', 'hello', {
      cwd: root,
      model: reference,
      providerOptions: { requestTimeoutMs: 10_000 },
      onStream: (event) => events.push(event as unknown as { type: string; data: Record<string, unknown> }),
    });

    expect(response.status).toBe('error');
    expect(response.content).toContain('Upstream error details are withheld');
    expect(response.content).not.toContain('SDK diagnostic');
    expect(response.content).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/u);

    const streamedFailureEvents = events.filter((event) => event.type === 'error' || event.type === 'result');
    expect(streamedFailureEvents).toHaveLength(2);
    const streamedMessages = streamedFailureEvents.flatMap((event) => Object.values(event.data)
      .filter((value): value is string => typeof value === 'string'));
    expect(streamedMessages).not.toHaveLength(0);
    for (const message of streamedMessages) {
      expect(message).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/u);
    }
    expect(streamedMessages.some((message) => message.includes('Upstream error details are withheld'))).toBe(true);
    expect(streamedMessages.some((message) => message.includes('SDK diagnostic'))).toBe(false);
  });

  it('preserves runtime setup diagnostics for a routed model', async () => {
    const reference = 'known-route/runtime-unavailable-model';
    const response = await callDeepSeekHarness('worker', 'hello', {
      cwd: root,
      model: reference,
      providerOptions: { requestTimeoutMs: 10_000 },
    });

    expect(response.status).toBe('error');
    expect(response.content).toContain('Unable to start DeepSeek Harness Python bridge');
    expect(response.content).toMatch(/managed environment|install/i);
    expect(response.content).not.toMatch(/python_path|Python 3\.10/iu);
  });

  it('preserves multiple assistant messages when the SDK omits chunk events', async () => {
    const textEvents: string[] = [];
    const response = await callDeepSeekHarness('worker', 'message-events', {
      cwd: root,
      providerOptions: { requestTimeoutMs: 10_000 },
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
      providerOptions: { requestTimeoutMs: 10_000 },
    });

    expect(response.status).toBe('error');
    expect(response.content).not.toContain(secret);
    expect(response.content).toContain('Upstream error details are withheld');
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
      providerOptions: { requestTimeoutMs: 10_000 },
      onStream: (event) => {
        events.push(event as unknown as { type: string; data: Record<string, unknown> });
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

  it('redacts secrets split across text and thinking stream events before logging them', async () => {
    const secret = 'deepseek-output-secret-456';
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const response = await callDeepSeekHarness('worker', 'split-secret-events', {
      cwd: root,
      childProcessEnv: { DEEPSEEK_API_KEY: secret },
      providerOptions: { requestTimeoutMs: 10_000 },
      onStream: (event) => events.push(event as unknown as { type: string; data: Record<string, unknown> }),
    });

    expect(response).toMatchObject({ status: 'done', content: '[REDACTED]' });
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(JSON.stringify(events)).toContain('[REDACTED]');
    expect(events.filter((event) => event.type === 'text' || event.type === 'thinking'))
      .toEqual(expect.arrayContaining([
        { type: 'thinking', data: { thinking: '[REDACTED]' } },
        { type: 'text', data: { text: '[REDACTED]' } },
      ]));
  });

  it.each([
    [['reasoning-delta', 'Let us'], ['text-delta', 'Answer']],
    [['text-delta', 'Let us'], ['reasoning-delta', 'Answer']],
    [['reasoning-delta', 'Let us'], ['text-delta', 'k-review'], ['reasoning-delta', ' safely'], ['text-delta', 'Answer']],
  ])('keeps delayed safe output in its original stream: %j', async (...chunks) => {
    const events: Array<{ type: string; text: string }> = [];
    const response = await callDeepSeekHarness('worker', `typed-stream:${JSON.stringify(chunks)}`, {
      cwd: root,
      childProcessEnv: { DEEPSEEK_API_KEY: 'sk-review-fixture-123' },
      providerOptions: { requestTimeoutMs: 10_000 },
      onStream: (event) => {
        if (event.type === 'text' || event.type === 'thinking') {
          const text = event.type === 'text' ? event.data.text : event.data.thinking;
          if (text.length > 0) events.push({ type: event.type, text });
        }
      },
    });

    expect(response.status).toBe('done');
    expect(events).toEqual(chunks.map(([kind, text]) => ({
      type: kind === 'reasoning-delta' ? 'thinking' : 'text',
      text,
    })));
  });

  it('drains long safe prefixes without losing the type of the retained suffix', async () => {
    const thinkingChunk = `${'a'.repeat(300)}s`;
    const chunks = [...Array.from({ length: 40 }, () => ['reasoning-delta', thinkingChunk]), ['text-delta', 'Answer']];
    let thinking = '';
    let text = '';
    const response = await callDeepSeekHarness('worker', `typed-stream:${JSON.stringify(chunks)}`, {
      cwd: root,
      childProcessEnv: { DEEPSEEK_API_KEY: 'sk-review-fixture-123' },
      providerOptions: { requestTimeoutMs: 10_000 },
      onStream: (event) => {
        if (event.type === 'thinking') thinking += event.data.thinking;
        if (event.type === 'text') text += event.data.text;
      },
    });

    expect(response.status).toBe('done');
    expect(thinking).toBe(thinkingChunk.repeat(40));
    expect(text).toBe('Answer');
  });

  it.each(['reasoning-delta', 'text-delta'] as const)('redacts a secret split across three alternating chunks starting with %s', async (firstKind) => {
    const secondKind = firstKind === 'reasoning-delta' ? 'text-delta' : 'reasoning-delta';
    const chunks = [[firstKind, 'Before sk-review'], [secondKind, '-fixture'], [firstKind, '-123 after']];
    const events: Array<{ type: string; text: string }> = [];
    const logsDir = path.join(root, 'logs');
    await mkdir(logsDir);
    const logger = createProviderEventLogger({
      logsDir, sessionId: 'typed-stream-session', runId: 'typed-stream-run', enabled: true,
    });
    const response = await callDeepSeekHarness('worker', `typed-stream:${JSON.stringify(chunks)}`, {
      cwd: root,
      childProcessEnv: { DEEPSEEK_API_KEY: 'sk-review-fixture-123' },
      providerOptions: { requestTimeoutMs: 10_000 },
      onStream: (event) => {
        logger.logEvent({ provider: 'deepseek-harness', providerModel: 'deepseek-v4-flash', step: 'redaction' }, event);
        if (event.type === 'text' || event.type === 'thinking') {
          const text = event.type === 'text' ? event.data.text : event.data.thinking;
          if (text.length > 0) events.push({ type: event.type, text });
        }
      },
    });

    expect(response.status).toBe('done');
    const firstType = firstKind === 'reasoning-delta' ? 'thinking' : 'text';
    expect(events).toEqual([
      { type: firstType, text: 'Before [REDACTED]' },
      { type: firstType === 'thinking' ? 'text' : 'thinking', text: '[REDACTED]' },
      { type: firstType, text: '[REDACTED] after' },
    ]);
    const log = await readFile(logger.filepath, 'utf8');
    for (const fragment of ['sk-review', '-fixture', '-123']) {
      expect(log).not.toContain(fragment);
    }
  });

  it('flushes a safe credential-boundary pending response at turn end', async () => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const response = await callDeepSeekHarness('worker', 'safe-credential-boundary', {
      cwd: root,
      providerOptions: { requestTimeoutMs: 10_000 },
      onStream: (event) => events.push(event as unknown as { type: string; data: Record<string, unknown> }),
    });

    expect(response).toMatchObject({ status: 'done', content: 'hello' });
    expect(events).toContainEqual({ type: 'text', data: { text: 'api_key=[REDACTED]' } });
    expect(JSON.stringify(events)).not.toContain('provider-config');
  });

  it('does not flush a known-secret pending response at successful turn end', async () => {
    const secret = 'pending-secret-value-123';
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const response = await callDeepSeekHarness('worker', 'pending-secret', {
      cwd: root,
      childProcessEnv: { DEEPSEEK_API_KEY: secret },
      providerOptions: { requestTimeoutMs: 10_000 },
      onStream: (event) => events.push(event as unknown as { type: string; data: Record<string, unknown> }),
    });

    expect(response).toMatchObject({ status: 'done', content: 'hello' });
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(JSON.stringify(events)).not.toContain(secret.slice(0, -1));
    const nonEmptyStreamText = events
      .filter((event) => event.type === 'text' || event.type === 'thinking')
      .map((event) => event.type === 'text' ? event.data.text : event.data.thinking)
      .filter((text): text is string => typeof text === 'string' && text.length > 0);
    expect(nonEmptyStreamText).toEqual([]);
  });

  it('rejects session identifiers that contain a known secret', async () => {
    const secret = 'deepseek-session-secret-789';
    const response = await callDeepSeekHarness('worker', 'hello', {
      cwd: root,
      sessionId: `session-${secret}`,
      childProcessEnv: { DEEPSEEK_API_KEY: secret },
      providerOptions: { requestTimeoutMs: 10_000 },
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
        baseUrl: `https://deepseek-user:${embeddedSecret}@deepseek.example/v1`,
        requestTimeoutMs: 10_000,
      },
    });

    expect(response.status).toBe('error');
    // Invalid effective URLs must not suggest repairing nonexistent stored settings.
    expect(response.content).toContain('Correct DEEPSEEK_BASE_URL');
    expect(response.content).toContain('without userinfo');
    expect(response.content).not.toContain('stored');
    expect(response.content).not.toContain('llm-deepseek.baseURL');
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
        baseUrl: `https://${encodedUsername}:${encodedPassword}@deepseek.example/v1`,
        requestTimeoutMs: 10_000,
      },
    });

    expect(response.status).toBe('error');
    expect(response.content).toMatch(/credential|endpoint/iu);
    expect(response.content).not.toContain(encodedUsername);
    expect(response.content).not.toContain(encodedPassword);
  });

  it('rejects tool identifiers that contain a configured secret', async () => {
    const secret = 'deepseek-tool-secret-345';
    const response = await callDeepSeekHarness('worker', 'secret-tool-id', {
      cwd: root,
      childProcessEnv: { DEEPSEEK_API_KEY: secret },
      providerOptions: { requestTimeoutMs: 10_000 },
    });

    expect(response.status).toBe('error');
    expect(response.content).toContain('tool ID must not contain configured secret values');
    expect(response.content).not.toContain(secret);
  });

  it.each([
    ['blocked', 'blocked', 'blocked'],
    ['max-tokens', 'error', 'maximum token limit'],
    ['interrupted', 'error', 'interrupted'],
    ['error', 'error', 'Upstream error details are withheld'],
  ] as const)('maps the official %s finish reason without reporting success', async (reason, status, message) => {
    const response = await callDeepSeekHarness('worker', `reason:${reason}`, {
      cwd: root,
      providerOptions: { requestTimeoutMs: 10_000 },
    });

    expect(response.status).toBe(status);
    expect(response.content).toContain(message);
    expect(response.status).not.toBe('done');
  });

  it('maps an SDK aborted finish reason to external_abort without reporting success', async () => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const response = await callDeepSeekHarness('worker', 'reason:aborted', {
      cwd: root,
      providerOptions: { requestTimeoutMs: 10_000 },
      onStream: (event) => events.push(event as unknown as { type: string; data: Record<string, unknown> }),
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
  ] as const)('preserves structured provider error status for model %s', async (model, _modelReference) => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const response = await callDeepSeekHarness('worker', 'reason:error', {
      cwd: root,
      ...(model === undefined ? {} : { model }),
      providerOptions: { requestTimeoutMs: 10_000 },
      onStream: (event) => events.push(event as unknown as { type: string; data: Record<string, unknown> }),
    });

    expect(response).toMatchObject({
      status: 'error',
      failureCategory: 'provider_error',
      error: response.content,
    });
    expect(response.content).toContain('provider bridge/SDK');
    expect(response.content).not.toContain('FAKE: provider failure');
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

  it.each(['reason:future-reason', 'empty-response'])('closes a session process after response validation fails for %s before its queued turn', async (prompt) => {
    const options = { cwd: root, sessionId: 'postrun-cleanup',
      providerOptions: { requestTimeoutMs: 10_000, shutdownTimeoutMs: 100 } };
    const [failed, next] = await Promise.all([
      callDeepSeekHarness('worker', prompt, options),
      callDeepSeekHarness('worker', 'next-turn', options),
    ]);
    expect(failed).toMatchObject({ status: 'error', failureCategory: 'provider_stream_parse_error', sessionId: options.sessionId });
    expect(next).toMatchObject({ status: 'done', sessionId: options.sessionId });
    expect((await readFile(path.join(root, 'bridge-start-configs.jsonl'), 'utf8')).trim().split('\n'))
      .toHaveLength(2);
  });

  it('rejects an unknown finish reason as a provider stream protocol error', async () => {
    const response = await callDeepSeekHarness('worker', 'reason:future-reason', {
      cwd: root,
      providerOptions: { requestTimeoutMs: 10_000 },
    });

    expect(response.status).toBe('error');
    expect(response.failureCategory).toBe('provider_stream_parse_error');
    expect(response.content).toContain('unsupported turn completion reason');
  });

  it('returns a provider error when SDK startup fails', async () => {
    const response = await callDeepSeekHarness('worker', 'hello', {
      cwd: root,
      model: 'start-failure-model',
      providerOptions: {
        requestTimeoutMs: 10_000,
      },
    });

    expect(response.status).toBe('error');
    expect(response.failureCategory).toBe('provider_error');
    expect(response.content).toContain('Upstream error details are withheld');
  });

  it('keeps SDK stdout noise off the bridge protocol stream', async () => {
    const response = await callDeepSeekHarness('worker', 'malformed-json', {
      cwd: root,
      providerOptions: { requestTimeoutMs: 10_000 },
    });

    expect(response).toMatchObject({ status: 'done', content: 'hello' });
  });

  it('maps malformed JSON bridge output to a stream protocol error', async () => {
    const response = await callDeepSeekHarness('worker', 'malformed-frame', {
      cwd: root,
      providerOptions: { requestTimeoutMs: 10_000 },
    });

    expect(response.status).toBe('error');
    expect(response.failureCategory).toBe('provider_stream_parse_error');
    expect(response.content).toContain('malformed JSON');
  });

  it('maps a malformed notification frame to a stream protocol error', async () => {
    const response = await callDeepSeekHarness('worker', 'malformed-notification', {
      cwd: root,
      providerOptions: { requestTimeoutMs: 10_000 },
    });

    expect(response.status).toBe('error');
    expect(response.failureCategory).toBe('provider_stream_parse_error');
    expect(response.content).toContain('malformed assistant chunk');
  });

  it('serializes concurrent SDK notifications without corrupting JSONL frames', async () => {
    const response = await callDeepSeekHarness('worker', 'concurrent-events', {
      cwd: root,
      providerOptions: { requestTimeoutMs: 10_000 },
    });

    expect(response).toMatchObject({ status: 'done', content: 'hello' });
  });

  it.each(['missing-turn-end', 'missing-result-reason', 'mismatched-reason'] as const)(
    'rejects %s when the bridge result and turn end reason do not match',
    async (input) => {
      const response = await callDeepSeekHarness('worker', input, {
        cwd: root,
        providerOptions: { requestTimeoutMs: 10_000 },
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
      providerOptions: { requestTimeoutMs: 10_000 },
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
      providerOptions: { requestTimeoutMs: 10_000 },
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
      providerOptions: { requestTimeoutMs: 10_000 },
    });

    expect(response.status).toBe('error');
    expect(response.failureCategory).toBe('provider_error');
    expect(response.content).toContain('Upstream error details are withheld');
  });

  it('does not let protocol-error cleanup race with the next queued session turn', async () => {
    const providerOptions = {
      requestTimeoutMs: 10_000,
      shutdownTimeoutMs: 100,
    } satisfies DeepSeekHarnessProviderOptions;
    const [failed, next] = await Promise.all([
      callDeepSeekHarness('worker', 'malformed-frame', {
        cwd: root,
        sessionId: 'protocol-cleanup-session',
        providerOptions,
      }),
      callDeepSeekHarness('worker', 'queued-turn', {
        cwd: root,
        sessionId: 'protocol-cleanup-session',
        providerOptions,
      }),
    ]);

    expect(failed).toMatchObject({ status: 'error', failureCategory: 'provider_stream_parse_error' });
    expect(next).toMatchObject({ status: 'done', sessionId: 'protocol-cleanup-session' });

    const configurations = (await readFile(path.join(root, 'bridge-start-configs.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(configurations).toHaveLength(2);
    const history = (await readFile(path.join(root, 'global', 'deepseek-harness', 'dsh-home', 'session-history.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(history).toEqual([
      { prompt: 'malformed-frame', reasoning_effort: null, sessionId: 'protocol-cleanup-session' },
      { prompt: 'queued-turn', reasoning_effort: null, sessionId: 'protocol-cleanup-session' },
    ]);
  });

  it('maps an unexpected bridge exit to a provider error without hanging', async () => {
    const response = await callDeepSeekHarness('worker', 'unexpected-exit', {
      cwd: root,
      providerOptions: { requestTimeoutMs: 10_000 },
    });

    expect(response.status).toBe('error');
    expect(response.failureCategory).toBe('provider_error');
    expect(response.content).toContain('Upstream error details are withheld');
  });

  it.each(['', '.', '..', '../outside', 'nested/session', 'C:\\outside'] as const)(
    'rejects path-like session IDs before starting the bridge: %s',
    async (sessionId) => {
      const response = await callDeepSeekHarness('worker', 'hello', {
        cwd: root,
        sessionId,
        providerOptions: { requestTimeoutMs: 10_000 },
      });

      expect(response.status).toBe('error');
      expect(response.content).toContain('path-safe identifier');
    },
  );

  it('reuses one Python bridge for repeated calls with the same session', async () => {
    const first = await callDeepSeekHarness('worker', 'hello', {
      cwd: root,
      sessionId: 'persistent-session',
      providerOptions: { requestTimeoutMs: 10_000 },
    });
    const second = await callDeepSeekHarness('worker', 'hello', {
      cwd: root,
      sessionId: 'persistent-session',
      providerOptions: { requestTimeoutMs: 10_000 },
    });

    expect(first).toMatchObject({ status: 'done', sessionId: 'persistent-session' });
    expect(second).toMatchObject({ status: 'done', sessionId: 'persistent-session' });
    expect((await readFile(path.join(root, 'bridge-start-configs.jsonl'), 'utf8'))
      .trim()
      .split('\n'))
      .toHaveLength(1);
  });

  it('isolates process replacement from another session using the same configuration', async () => {
    for (const sessionId of ['effort-a', 'effort-b']) {
      expect((await callDeepSeekHarness('worker', 'initial', {
        cwd: root, sessionId, providerOptions: { reasoningEffort: 'high' },
      })).status).toBe('done');
    }
    const results = await Promise.all([
      callDeepSeekHarness('worker', 'switch-a', {
        cwd: root, sessionId: 'effort-a', providerOptions: { reasoningEffort: 'max' },
      }),
      callDeepSeekHarness('worker', 'continue-b', {
        cwd: root, sessionId: 'effort-b', providerOptions: { reasoningEffort: 'high' },
      }),
    ]);
    expect(results.map((result) => result.status)).toEqual(['done', 'done']);
    const configurations = (await readFile(path.join(root, 'bridge-start-configs.jsonl'), 'utf8'))
      .trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(configurations.map((config) => config.reasoning_effort)).toEqual(['high', 'high', 'max']);
  });

  it('preserves the session when its only option is added and removed', async () => {
    for (const reasoningEffort of [undefined, 'high', undefined] as const) {
      const result = await callDeepSeekHarness('worker', 'turn', {
        cwd: root, sessionId: 'only-effort-session',
        ...(reasoningEffort === undefined ? {} : { providerOptions: { reasoningEffort } }),
      });
      expect(result).toMatchObject({ status: 'done', sessionId: 'only-effort-session' });
    }
  });

  it('changes reasoning effort between turns without losing the session or durable history', async () => {
    const first = await callDeepSeekHarness('worker', 'turn-1', {
      cwd: root,
      sessionId: 'effort-session',
      providerOptions: {
        requestTimeoutMs: 10_000,
        reasoningEffort: 'high',
      },
    });
    const second = await callDeepSeekHarness('worker', 'turn-2', {
      cwd: root,
      sessionId: 'effort-session',
      providerOptions: {
        requestTimeoutMs: 10_000,
        reasoningEffort: 'max',
      },
    });
    const third = await callDeepSeekHarness('worker', 'turn-3', {
      cwd: root,
      sessionId: 'effort-session',
      providerOptions: { requestTimeoutMs: 10_000 },
    });

    expect(first).toMatchObject({ status: 'done', sessionId: 'effort-session' });
    expect(second).toMatchObject({ status: 'done', sessionId: 'effort-session' });
    expect(third).toMatchObject({ status: 'done', sessionId: 'effort-session' });

    const configurations = (await readFile(path.join(root, 'bridge-start-configs.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(configurations).toHaveLength(3);
    expect(configurations.map((configuration) => configuration.reasoning_effort))
      .toEqual(['high', 'max', undefined]);

    const history = (await readFile(path.join(root, 'global', 'deepseek-harness', 'dsh-home', 'session-history.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(history).toEqual([
      { prompt: 'turn-1', reasoning_effort: 'high', sessionId: 'effort-session' },
      { prompt: 'turn-2', reasoning_effort: 'max', sessionId: 'effort-session' },
      { prompt: 'turn-3', reasoning_effort: null, sessionId: 'effort-session' },
    ]);
  });

  it('serializes concurrent effort changes for one session before selecting the replacement process', async () => {
    const [first, second] = await Promise.all([
      callDeepSeekHarness('worker', 'parallel-high', {
        cwd: root,
        sessionId: 'concurrent-effort-session',
        providerOptions: {
          requestTimeoutMs: 10_000,
          reasoningEffort: 'high',
        },
      }),
      callDeepSeekHarness('worker', 'parallel-max', {
        cwd: root,
        sessionId: 'concurrent-effort-session',
        providerOptions: {
          requestTimeoutMs: 10_000,
          reasoningEffort: 'max',
        },
      }),
    ]);

    expect(first).toMatchObject({ status: 'done', sessionId: 'concurrent-effort-session' });
    expect(second).toMatchObject({ status: 'done', sessionId: 'concurrent-effort-session' });

    const configurations = (await readFile(path.join(root, 'bridge-start-configs.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(configurations.map((configuration) => configuration.reasoning_effort))
      .toEqual(['high', 'max']);

    const history = (await readFile(path.join(root, 'global', 'deepseek-harness', 'dsh-home', 'session-history.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(history.map((entry) => [entry.prompt, entry.reasoning_effort, entry.sessionId]))
      .toEqual([
        ['parallel-high', 'high', 'concurrent-effort-session'],
        ['parallel-max', 'max', 'concurrent-effort-session'],
      ]);
  });

  it('propagates a replacement process failure instead of continuing with the previous effort', async () => {
    const first = await callDeepSeekHarness('worker', 'turn-1', {
      cwd: root,
      sessionId: 'failed-replacement-session',
      providerOptions: {
        requestTimeoutMs: 10_000,
        reasoningEffort: 'high',
      },
    });
    await writeFile(path.join(root, 'fail-max-effort'), 'fail', 'utf8');
    const failed = await callDeepSeekHarness('worker', 'turn-2', {
      cwd: root,
      sessionId: 'failed-replacement-session',
      providerOptions: {
        requestTimeoutMs: 10_000,
        reasoningEffort: 'max',
      },
    });
    const third = await callDeepSeekHarness('worker', 'turn-3', {
      cwd: root,
      sessionId: 'failed-replacement-session',
      providerOptions: {
        requestTimeoutMs: 10_000,
        reasoningEffort: 'high',
      },
    });

    expect(first.status).toBe('done');
    expect(failed.status).toBe('error');
    expect(failed.content).toContain('Upstream error details are withheld');
    expect(third.status).toBe('done');
    const configurations = (await readFile(path.join(root, 'bridge-start-configs.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(configurations.map((configuration) => configuration.reasoning_effort))
      .toEqual(['high', 'max', 'high']);
    expect([first.sessionId, failed.sessionId, third.sessionId])
      .toEqual(Array.from({ length: 3 }, () => 'failed-replacement-session'));
    const history = (await readFile(path.join(root, 'global', 'deepseek-harness', 'dsh-home', 'session-history.jsonl'), 'utf8'))
      .trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(history).toEqual([
      { prompt: 'turn-1', reasoning_effort: 'high', sessionId: 'failed-replacement-session' },
      { prompt: 'turn-3', reasoning_effort: 'high', sessionId: 'failed-replacement-session' },
    ]);
  });

  it('reuses one process when bare and explicit default routes have the same effective identity', async () => {
    const first = await callDeepSeekHarness('worker', 'hello', {
      cwd: root,
      model: 'deepseek-v4-flash',
      sessionId: 'default-route-session',
      providerOptions: { requestTimeoutMs: 10_000 },
    });
    const second = await callDeepSeekHarness('worker', 'hello', {
      cwd: root,
      model: 'deepseek-official/deepseek-v4-flash',
      sessionId: 'default-route-session',
      providerOptions: { requestTimeoutMs: 10_000 },
    });

    expect(first.status).toBe('done');
    expect(second.status).toBe('done');
    expect((await readFile(path.join(root, 'bridge-start-configs.jsonl'), 'utf8'))
      .trim()
      .split('\n'))
      .toHaveLength(1);
  });

  it('does not share a process when the effective route or model changes', async () => {
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
        providerOptions: { requestTimeoutMs: 10_000 },
      });
      expect(response.status).toBe('done');
    }

    expect((await readFile(path.join(root, 'bridge-start-configs.jsonl'), 'utf8'))
      .trim()
      .split('\n'))
      .toHaveLength(3);
  });

  it('maps a request timeout to a bounded part-timeout failure and closes the bridge', async () => {
    const startedAt = Date.now();
    const response = await callDeepSeekHarness('worker', 'hang', {
      cwd: root,
      providerOptions: {
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
        requestTimeoutMs: 10_000,
        shutdownTimeoutMs: 100,
      },
    });

    expect(response.status).toBe('done');
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it('terminates the probe and does not start the bridge when startup is aborted', async () => {
    vi.stubEnv('FAKE_PROBE_HANG', '1');
    const probeStartedPath = path.join(root, 'probe-started.marker');
    const controller = new AbortController();
    const call = callDeepSeekHarness('worker', 'hello', {
      cwd: root,
      abortSignal: controller.signal,
      providerOptions: { requestTimeoutMs: 10_000 },
    });

    await vi.waitFor(async () => {
      await expect(readFile(probeStartedPath, 'utf8')).resolves.toMatch(/\d+\n/u);
    });
    controller.abort(new Error('cancelled during runtime probe'));

    const response = await call;
    expect(response.status).toBe('error');
    expect(response.failureCategory).toBe('external_abort');
    expect(response.content).toContain('cancelled during runtime probe');
    await expect(readFile(path.join(root, 'bridge-start-configs.jsonl'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('times out a hung runtime probe without starting the bridge', async () => {
    vi.stubEnv('FAKE_PROBE_HANG', '1');
    const startedAt = Date.now();
    const response = await callDeepSeekHarness('worker', 'hello', {
      cwd: root,
      providerOptions: { requestTimeoutMs: 100 },
    });

    expect(response.status).toBe('error');
    expect(response.failureCategory).toBe('part_timeout');
    expect(response.content).toContain('timed out');
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    await expect(readFile(path.join(root, 'bridge-start-configs.jsonl'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('terminates the Python bridge when the caller aborts a running SDK turn', async () => {
    const controller = new AbortController();
    const startedAt = Date.now();
    const call = callDeepSeekHarness('worker', 'hang', {
      cwd: root,
      abortSignal: controller.signal,
      providerOptions: { requestTimeoutMs: 10_000 },
    });
    setTimeout(() => controller.abort(new Error('cancelled by test')), 100).unref();

    const response = await call;
    expect(response.status).toBe('error');
    expect(response.failureCategory).toBe('external_abort');
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  });

  it('hands the credential store path and default reference to the official runtime', async () => {
    const response = await callDeepSeekHarness('worker', 'inspect-env', {
      cwd: root,
      childProcessEnv: { DEEPSEEK_API_KEY: 'deepseek-env-secret' },
      providerOptions: { requestTimeoutMs: 10_000 },
    });
    const [configuration] = (await readFile(path.join(root, 'bridge-start-configs.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const patches = await readBridgePatches(root);

    expect(response.status).toBe('done');
    expect(configuration?.patches).toEqual([patches[0]?.path]);
    expect(patches[0]?.content).toContain('apiKeyEnv: DEEPSEEK_API_KEY');
    expect(patches[0]?.content).toContain(path.join(sourceHome, '.credentials.yaml'));
  });

  it('reads the custom reference from the source home settings without touching the credential store', async () => {
    await writeSourceSettings(sourceHome, 'llm-deepseek:\n  apiKeyEnv: CUSTOM_DSH_KEY\n');
    const unselected = 'unselected-reference-secret';
    const response = await callDeepSeekHarness('worker', 'inspect-env', {
      cwd: root,
      childProcessEnv: { CUSTOM_DSH_KEY: 'custom-source-secret', DEEPSEEK_API_KEY: unselected },
      providerOptions: { requestTimeoutMs: 10_000 },
    });
    const bridgeEnvironment = JSON.parse(await readFile(path.join(root, 'bridge-env.json'), 'utf8')) as Record<string, string>;
    const patches = await readBridgePatches(root);

    expect(response.status).toBe('done');
    expect(bridgeEnvironment.CUSTOM_DSH_KEY).toBe('custom-source-secret');
    expect(Object.prototype.hasOwnProperty.call(bridgeEnvironment, 'DEEPSEEK_API_KEY')).toBe(false);
    expect(Object.values(bridgeEnvironment)).not.toContain(unselected);
    expect(patches[0]?.content).toContain('apiKeyEnv: CUSTOM_DSH_KEY');
    expect(patches[0]?.content).toContain(path.join(sourceHome, '.credentials.yaml'));
    expect(await readdir(sourceHome)).toEqual(['settings.yaml']);
    await expect(readFile(path.join(globalConfigDir, 'deepseek-harness', 'dsh-home', 'session-history.jsonl'), 'utf8'))
      .resolves.toContain('inspect-env');
  });

  it('redacts the selected custom reference value from provider failures', async () => {
    await writeSourceSettings(sourceHome, 'llm-deepseek:\n  apiKeyEnv: CUSTOM_DSH_KEY\n');
    const secret = 'custom-reference-secret-321';
    const response = await callDeepSeekHarness('worker', 'fail-custom-ref', {
      cwd: root,
      childProcessEnv: { CUSTOM_DSH_KEY: secret },
      providerOptions: { requestTimeoutMs: 10_000 },
    });

    expect(response.status).toBe('error');
    expect(response.content).not.toContain(secret);
    expect(response.content).toContain('Upstream error details are withheld');
  });

  it('does not substitute an unselected DEEPSEEK_API_KEY for another selected reference', async () => {
    await writeSourceSettings(sourceHome, 'llm-deepseek:\n  apiKeyEnv: CUSTOM_DSH_KEY\n');
    const unselected = 'unselected-reference-secret';
    const response = await callDeepSeekHarness('worker', 'fail-secret', {
      cwd: root,
      childProcessEnv: { DEEPSEEK_API_KEY: unselected },
      providerOptions: { requestTimeoutMs: 10_000 },
    });
    const patches = await readBridgePatches(root);

    expect(response.status).toBe('error');
    expect(response.content).toContain('Upstream error details are withheld');
    expect(response.content).not.toContain(unselected);
    expect(patches[0]?.content).toContain('apiKeyEnv: CUSTOM_DSH_KEY');
  });

  it.each(['unknown-store-failure', 'unknown-store-exit'])(
    'withholds unknown store errors and stderr from output, notifications and persisted logs: %s', async (prompt) => {
      await mkdir(path.join(root, 'safe-error-logs'));
      const logger = createProviderEventLogger({
        logsDir: path.join(root, 'safe-error-logs'), sessionId: prompt, runId: 'safe-error', enabled: true,
      });
      const events: unknown[] = [];
      const response = await callDeepSeekHarness('worker', prompt, {
        cwd: root,
        providerOptions: { requestTimeoutMs: 10_000 },
        onStream: (event) => {
          events.push(event);
          logger.logEvent({ provider: 'deepseek-harness', providerModel: 'deepseek-v4-flash', step: 'smoke' }, event);
        },
      });
      expect(response.status).toBe('error');
      expect(response.content).toContain('Upstream error details are withheld');
      const timestamp = '2026-09-24T12:00:00.000Z';
      const report = renderTraceReportFromRecords({
        tracePath: path.join(root, 'trace.md'), workflowName: 'smoke', task: prompt,
        runSlug: 'safe-error', status: 'failed', iterations: 1, endTime: timestamp,
      }, [{
        type: 'step_complete', step: 'smoke', persona: 'worker', iteration: 1,
        status: response.status, content: response.content, instruction: prompt, timestamp,
      }], [], 'full');
      expect(report).toContain('Upstream error details are withheld');
      for (const surface of [JSON.stringify(response), JSON.stringify(events), await readFile(logger.filepath, 'utf8'), report!]) {
        for (const secret of ['unclassified-store-secret', 'nested-cause-secret', 'stderr-only-store-secret']) {
          expect(surface).not.toContain(secret);
        }
      }
    },
  );

  it('uses the default harness home when neither environment defines DSH_HOME', async () => {
    const userHome = path.join(root, 'user-home');
    await mkdir(userHome, { recursive: true });
    vi.stubEnv('DSH_HOME', undefined);
    vi.stubEnv('HOME', userHome);

    const response = await callDeepSeekHarness('worker', 'hello', {
      cwd: root,
      providerOptions: { requestTimeoutMs: 10_000 },
    });
    const patches = await readBridgePatches(root);

    expect(response.status).toBe('done');
    expect(patches[0]?.content).toContain(path.join(userHome, '.dsh', '.credentials.yaml'));
  });

  it.each([
    ['relative', 'relative/source-home'],
    ['empty', ''],
  ] as const)('rejects an explicit %s DSH_HOME before starting the bridge', async (_label, dshHome) => {
    vi.stubEnv('DSH_HOME', dshHome);
    const response = await callDeepSeekHarness('worker', 'hello', {
      cwd: root,
      providerOptions: { requestTimeoutMs: 10_000 },
    });

    expect(response.status).toBe('error');
    expect(response.content).toContain('DSH_HOME');
    await expect(readFile(path.join(root, 'bridge-start-configs.jsonl'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    ['duplicate selector', 'llm-deepseek:\n  apiKeyEnv: FIRST_KEY\n  apiKeyEnv: SECOND_KEY\n', 'FIRST_KEY'],
    ['unparsable document', 'llm-deepseek: [unclosed\n', 'unclosed'],
    ['invalid reference', 'llm-deepseek:\n  apiKeyEnv: 1INVALID\n', '1INVALID'],
  ] as const)('rejects an unsafe settings document (%s) before starting the bridge', async (_label, content, fragment) => {
    await writeSourceSettings(sourceHome, content);
    const response = await callDeepSeekHarness('worker', 'hello', {
      cwd: root,
      providerOptions: { requestTimeoutMs: 10_000 },
    });

    expect(response.status).toBe('error');
    expect(response.content).not.toContain(fragment);
    expect(response.content).toContain('Reference: unresolved');
    expect(response.content).not.toContain('Reference: DEEPSEEK_API_KEY');
    await expect(readFile(path.join(root, 'bridge-start-configs.jsonl'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a stored endpoint that disagrees with the effective endpoint before starting the bridge', async () => {
    await writeSourceSettings(sourceHome, 'llm-deepseek:\n  baseURL: https://stored.example/v1\n');
    const response = await callDeepSeekHarness('worker', 'hello', {
      cwd: root,
      providerOptions: { baseUrl: 'https://effective.example/v1', requestTimeoutMs: 10_000 },
    });

    expect(response.status).toBe('error');
    expect(response.content).not.toContain('https://stored.example/v1');
    expect(response.content).not.toContain('https://effective.example/v1');
    await expect(readFile(path.join(root, 'bridge-start-configs.jsonl'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('continues when the stored baseURL matches the effective endpoint', async () => {
    await writeSourceSettings(sourceHome, 'llm-deepseek:\n  baseURL: https://api.deepseek.com\n');
    const response = await callDeepSeekHarness('worker', 'hello', {
      cwd: root,
      providerOptions: { baseUrl: 'https://api.deepseek.com/', requestTimeoutMs: 10_000 },
    });

    expect(response.status).toBe('done');
  });

  it('fails an existing session turn when the credential binding changes', async () => {
    const firstSourceHome = path.join(root, 'first-source-home');
    const secondSourceHome = path.join(root, 'second-source-home');
    await writeSourceSettings(firstSourceHome, 'llm-deepseek:\n  apiKeyEnv: FIRST_REF\n');
    await writeSourceSettings(secondSourceHome, 'llm-deepseek:\n  apiKeyEnv: SECOND_REF\n');

    const first = await callDeepSeekHarness('worker', 'first-turn', {
      cwd: root,
      sessionId: 'binding-change-session',
      childProcessEnv: { DSH_HOME: firstSourceHome, FIRST_REF: 'first-ref-secret' },
      providerOptions: { requestTimeoutMs: 10_000 },
    });
    const failed = await callDeepSeekHarness('worker', 'second-turn', {
      cwd: root,
      sessionId: 'binding-change-session',
      childProcessEnv: { DSH_HOME: secondSourceHome, SECOND_REF: 'second-ref-secret' },
      providerOptions: { requestTimeoutMs: 10_000 },
    });

    expect(first.status).toBe('done');
    expect(failed.status).toBe('error');
    expect(failed.content).toMatch(/binding/iu);
    expect(failed.content).toMatch(/new (run|session)/iu);
    expect(failed.content).not.toContain('second-ref-secret');
    expect((await readFile(path.join(root, 'bridge-start-configs.jsonl'), 'utf8')).trim().split('\n'))
      .toHaveLength(1);
    const history = (await readFile(path.join(globalConfigDir, 'deepseek-harness', 'dsh-home', 'session-history.jsonl'), 'utf8'))
      .trim()
      .split('\n');
    expect(history).toHaveLength(1);
  });

  it('removes the temporary credential patch after the one-shot bridge closes', async () => {
    const response = await callDeepSeekHarness('worker', 'hello', {
      cwd: root,
      providerOptions: { requestTimeoutMs: 10_000 },
    });
    const patches = await readBridgePatches(root);
    const patchPath = patches[0]?.path;

    expect(response.status).toBe('done');
    expect(typeof patchPath).toBe('string');
    if (patchPath === undefined) {
      throw new Error('the bridge did not receive a credential patch');
    }
    await expect(stat(patchPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(path.dirname(patchPath))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('DeepSeek Harness session dispatch ordering', () => {
  it('keeps the session tail after a queued caller abort', async () => {
    const queue = createSessionDispatchQueue();
    let releaseFirst: (() => void) | undefined;
    let firstFinished = false;
    let thirdStarted = false;
    const first = queue.run('session', undefined, async () => new Promise<void>((resolve) => {
      releaseFirst = (): void => {
        firstFinished = true;
        resolve();
      };
    }));
    await vi.waitFor(() => {
      expect(releaseFirst).toBeTypeOf('function');
    });

    const controller = new AbortController();
    const second = queue.run('session', controller.signal, async () => {
      throw new Error('aborted turn must not run');
    });
    const third = queue.run('session', undefined, async () => {
      thirdStarted = true;
      expect(firstFinished).toBe(true);
    });
    controller.abort(new Error('cancelled while waiting for session dispatch'));

    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(thirdStarted).toBe(false);

    releaseFirst?.();
    await expect(first).resolves.toBeUndefined();
    await expect(third).resolves.toBeUndefined();
    expect(thirdStarted).toBe(true);
  });

  it('does not start a pre-aborted queued operation or release the session tail', async () => {
    const queue = createSessionDispatchQueue();
    let releaseFirst: (() => void) | undefined;
    let firstFinished = false;
    let secondStarted = false;
    let thirdStarted = false;
    const first = queue.run('session', undefined, async () => new Promise<void>((resolve) => {
      releaseFirst = (): void => {
        firstFinished = true;
        resolve();
      };
    }));
    await vi.waitFor(() => {
      expect(releaseFirst).toBeTypeOf('function');
    });

    const controller = new AbortController();
    controller.abort(new Error('already cancelled'));
    const second = queue.run('session', controller.signal, async () => {
      secondStarted = true;
    });
    const third = queue.run('session', undefined, async () => {
      thirdStarted = true;
      expect(firstFinished).toBe(true);
    });

    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(secondStarted).toBe(false);
    expect(thirdStarted).toBe(false);

    releaseFirst?.();
    await expect(first).resolves.toBeUndefined();
    await expect(third).resolves.toBeUndefined();
    expect(thirdStarted).toBe(true);
  });
});
