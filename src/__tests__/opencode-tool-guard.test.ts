import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OPENCODE_GUARD_REGISTRY,
  OpenCodeGuardSuite,
  resolveOpenCodeGuardProfile,
  resolveOpenCodeGuardSuite,
  type OpenCodeGuard,
  type OpenCodeGuardDescriptor,
} from '../infra/opencode/guards/index.js';
import {
  createToolGuardRecoveryState,
  markToolGuardCorrectionPending,
  shouldIssueToolGuardCorrection,
} from '../infra/opencode/tool-guard.js';
import {
  OPENCODE_STREAM_EVENT_LIMIT,
  type OpenCodeStreamEvent,
} from '../infra/opencode/OpenCodeStreamHandler.js';
import {
  computeToolInputHash,
  computeToolResultHash,
} from '../infra/opencode/tool-call-tuple.js';
import { readOpenCodeToolPart } from '../infra/opencode/guards/tool-events.js';
import { ExactLoopGuard } from '../infra/opencode/guards/integrity-guards.js';
import { SensitiveBudgetGuard } from '../infra/opencode/guards/resource-guards.js';
import { createBoundedSensitiveValues } from '../shared/utils/sensitiveText.js';

const DEPRECATED_ENV_KEYS = [
  'TAKT_OPENCODE_TOOL_ERROR_BUDGET',
  'TAKT_OPENCODE_TOOL_SIGNATURE_ABSOLUTE',
  'TAKT_OPENCODE_TOOL_SIGNATURE_REPEATS',
  'TAKT_OPENCODE_TOOL_SUCCESS_REPEATS',
  'TAKT_OPENCODE_TOOL_RESULT_STAGNATION_REPEATS',
] as const;

const ENV_KEYS = [
  'TAKT_OPENCODE_MESSAGE_CYCLE_BUDGET',
  'TAKT_OPENCODE_TOOL_ERROR_CONSECUTIVE',
  'TAKT_OPENCODE_TOOL_ERROR_WINDOW',
  'TAKT_OPENCODE_TOOL_ERROR_WINDOW_RATE',
  ...DEPRECATED_ENV_KEYS,
  'TAKT_OPENCODE_STREAM_EVENT_LIMIT',
  'TAKT_OPENCODE_STREAM_IDLE_TIMEOUT_MS',
] as const;

afterEach(() => {
  vi.useRealTimers();
  for (const key of ENV_KEYS) delete process.env[key];
});

function completedTool(
  callId: string,
  input: Record<string, unknown>,
  output: string,
  options: { tool?: string; exit?: number | null } = {},
): OpenCodeStreamEvent {
  return {
    type: 'message.part.updated',
    properties: {
      part: {
        id: `part-${callId}`,
        sessionID: 'session-1',
        type: 'tool',
        callID: callId,
        tool: options.tool ?? 'read',
        state: {
          status: 'completed',
          input,
          output,
          title: options.tool ?? 'read',
          ...(Object.prototype.hasOwnProperty.call(options, 'exit')
            ? { metadata: { exit: options.exit } }
            : {}),
        },
      },
    },
  };
}

function errorTool(
  callId: string,
  tool: string,
  error: string,
  input: Record<string, unknown> = {},
): OpenCodeStreamEvent {
  return {
    type: 'message.part.updated',
    properties: {
      part: {
        id: `part-${callId}`,
        sessionID: 'session-1',
        type: 'tool',
        callID: callId,
        tool,
        state: { status: 'error', input, error },
      },
    },
  };
}

function runningTool(
  callId: string,
  input: Record<string, unknown>,
  tool = 'bash',
): OpenCodeStreamEvent {
  return {
    type: 'message.part.updated',
    properties: {
      part: {
        id: `part-${callId}`,
        sessionID: 'session-1',
        type: 'tool',
        callID: callId,
        tool,
        state: { status: 'running', input, title: tool },
      },
    },
  };
}

function completedMessage(id: string, sessionID = 'session-1'): OpenCodeStreamEvent {
  return {
    type: 'message.updated',
    properties: {
      info: {
        id,
        sessionID,
        role: 'assistant',
        time: { completed: 1 },
      },
    },
  } as OpenCodeStreamEvent;
}

describe('OpenCode guard registry / Strategy', () => {
  it('設計表どおり11ガードを登録する', () => {
    expect(OPENCODE_GUARD_REGISTRY.map(({ id, layer, mandatory }) => ({ id, layer, mandatory }))).toEqual([
      { id: 'text-volume', layer: 'resource', mandatory: true },
      { id: 'reasoning-volume', layer: 'resource', mandatory: true },
      { id: 'event-count', layer: 'resource', mandatory: true },
      { id: 'tracked-ids', layer: 'resource', mandatory: true },
      { id: 'sensitive-budget', layer: 'integrity', mandatory: true },
      { id: 'wall-clock', layer: 'time', mandatory: true },
      { id: 'idle-timeout', layer: 'time', mandatory: true },
      { id: 'exact-loop', layer: 'integrity', mandatory: true },
      { id: 'consecutive-errors', layer: 'heuristic', mandatory: false },
      { id: 'cycle-budget', layer: 'heuristic', mandatory: false },
      { id: 'exact-repeat-streak', layer: 'heuristic', mandatory: false },
    ]);
  });

  it('standard は全ガード、minimal は mandatory だけを選ぶ', () => {
    const standard = resolveOpenCodeGuardSuite(undefined, 'opencode/big-pickle');
    const minimal = resolveOpenCodeGuardSuite({ profile: 'minimal' }, 'opencode/big-pickle');

    expect(standard.enabledGuardIds).toEqual(OPENCODE_GUARD_REGISTRY.map((guard) => guard.id));
    expect(minimal.enabledGuardIds).toEqual(
      OPENCODE_GUARD_REGISTRY.filter((guard) => guard.mandatory).map((guard) => guard.id),
    );
    expect(minimal.enabledGuardIds).toContain('wall-clock');
    expect(minimal.enabledGuardIds).toContain('exact-loop');
  });

  it('event count guard は既定で 500,000 を使う', () => {
    expect(OPENCODE_STREAM_EVENT_LIMIT).toBe(500_000);
    expect(resolveOpenCodeGuardSuite(undefined, 'opencode/big-pickle').policy.streamEventLimit)
      .toBe(500_000);
  });

  it('event count guard は delta と part.updated を除外し、上限ちょうどを受理して +1 で失敗する', () => {
    const suite = resolveOpenCodeGuardSuite({ profile: 'minimal', eventLimit: 2 }, 'opencode/big-pickle');
    const deltaEvent = {
      type: 'message.part.delta',
      properties: {
        sessionID: 'session-1',
        partID: 'text-1',
        field: 'text',
        delta: 'x',
        guardPartType: 'text',
      },
    } as OpenCodeStreamEvent;
    const updatedEvent = {
      type: 'message.part.updated',
      properties: {
        part: { id: 'text-1', sessionID: 'session-1', type: 'text', text: 'x' },
      },
    } as OpenCodeStreamEvent;

    expect(suite.onEvent(deltaEvent).failure).toBeUndefined();
    expect(suite.onEvent(updatedEvent).failure).toBeUndefined();
    expect(suite.onEvent(completedMessage('message-1')).failure).toBeUndefined();
    expect(suite.onEvent(completedMessage('message-2')).failure).toBeUndefined();
    expect(suite.onEvent(completedMessage('message-3')).failure).toMatchObject({
      guardId: 'event-count',
      verdict: { reason: 'OpenCode stream tracking limit exceeded: event_count' },
    });
  });

  it('TAKT_OPENCODE_STREAM_EVENT_LIMIT は guard 設定を上書きする', () => {
    process.env.TAKT_OPENCODE_STREAM_EVENT_LIMIT = '3';

    const suite = resolveOpenCodeGuardSuite({ eventLimit: 2 }, 'opencode/big-pickle');

    expect(suite.policy.streamEventLimit).toBe(3);
    expect(suite.onEvent(completedMessage('message-1')).failure).toBeUndefined();
    expect(suite.onEvent(completedMessage('message-2')).failure).toBeUndefined();
    expect(suite.onEvent(completedMessage('message-3')).failure).toBeUndefined();
    expect(suite.onEvent(completedMessage('message-4')).failure).toMatchObject({
      guardId: 'event-count',
    });
  });

  it.each([0, 1.5, -5])('guards.eventLimit の不正値 %s は fail-fast で reject する', (invalid) => {
    expect(() => resolveOpenCodeGuardSuite({ eventLimit: invalid }, 'opencode/big-pickle'))
      .toThrow('OpenCode event limit must be a positive integer');
  });

  it.each(['0', '1.5', '-5', 'abc'])(
    'TAKT_OPENCODE_STREAM_EVENT_LIMIT の不正値 %s は既定値へ fallback する',
    (invalid) => {
      process.env.TAKT_OPENCODE_STREAM_EVENT_LIMIT = invalid;

      expect(resolveOpenCodeGuardSuite(undefined, 'opencode/big-pickle').policy.streamEventLimit)
        .toBe(OPENCODE_STREAM_EVENT_LIMIT);
    },
  );

  it('mandatory guard は minimal・未知 profile・設定キーで無効化できない', () => {
    const minimal = resolveOpenCodeGuardSuite({ profile: 'minimal' }, 'opencode/model');
    expect(minimal.enabledGuardIds).toEqual(expect.arrayContaining(
      OPENCODE_GUARD_REGISTRY.filter((guard) => guard.mandatory).map((guard) => guard.id),
    ));
    expect(() => resolveOpenCodeGuardSuite(
      { profile: 'disabled' as never },
      'opencode/model',
    )).toThrow('Unknown OpenCode guard profile: disabled');
    expect(() => resolveOpenCodeGuardSuite(
      undefined,
      'opencode/model',
      [],
    )).toThrow('attempted to remove a mandatory guard');
  });

  it('model_profiles は記述順の先勝ちで `*` だけをワイルドカードとして扱う', () => {
    const guards = {
      profile: 'minimal' as const,
      modelProfiles: {
        'opencode/*': 'standard' as const,
        'opencode/big-pickle': 'minimal' as const,
        'lmstudio/model+v1': 'standard' as const,
      },
    };

    expect(resolveOpenCodeGuardProfile(guards, 'opencode/big-pickle')).toBe('standard');
    expect(resolveOpenCodeGuardProfile(guards, 'lmstudio/model+v1')).toBe('standard');
    expect(resolveOpenCodeGuardProfile(guards, 'lmstudio/model-v1')).toBe('minimal');
    expect(resolveOpenCodeGuardProfile(guards, 'ollama/qwen')).toBe('minimal');
  });
});

describe('OpenCode guard suite', () => {
  it('初期ソース hook は具象 guard 型や sensitive-budget id に依存しない', () => {
    const resolved = resolveOpenCodeGuardSuite(undefined, 'opencode/model');
    const sensitiveValues = createBoundedSensitiveValues();
    const replacement: OpenCodeGuard = {
      id: 'replacement-integrity-guard',
      layer: 'integrity',
      onInitialSource: () => ({ action: 'fail', reason: 'replacement failure' }),
    };
    const suite = new OpenCodeGuardSuite(resolved.policy, [replacement], { sensitiveValues });

    expect(suite.sensitiveValues).toBe(sensitiveValues);
    expect(suite.onInitialSource({ token: 'secret' }).failure).toMatchObject({
      guardId: 'replacement-integrity-guard',
      verdict: { reason: 'replacement failure' },
    });
  });

  it('terminal tool の完全一致タプルが連続12回で停止する', () => {
    const suite = resolveOpenCodeGuardSuite(undefined, 'opencode/big-pickle');
    for (let index = 1; index < 12; index += 1) {
      expect(suite.onEvent(completedTool(`call-${index}`, { filePath: 'a.ts' }, 'same')).failure).toBeUndefined();
    }
    expect(suite.onEvent(completedTool('call-12', { filePath: 'a.ts' }, 'same')).failure).toMatchObject({
      guardId: 'exact-repeat-streak',
    });
  });

  it('exact tool outcome streak は attempt 境界を越えて持ち越さない', () => {
    const suite = resolveOpenCodeGuardSuite(undefined, 'opencode/big-pickle');
    suite.startAttempt(() => undefined);
    for (let index = 1; index < 12; index += 1) {
      expect(suite.onEvent(completedTool(`first-${index}`, { filePath: 'a.ts' }, 'same')).failure)
        .toBeUndefined();
    }
    suite.stopAttempt();

    suite.startAttempt(() => undefined);
    expect(suite.onEvent(completedTool('second-1', { filePath: 'a.ts' }, 'same')).failure)
      .toBeUndefined();
    suite.stopAttempt();
  });

  it('結果が変わる正当な polling は完全一致ストリークをリセットする', () => {
    const suite = resolveOpenCodeGuardSuite(undefined, 'opencode/big-pickle');
    for (let index = 0; index < 20; index += 1) {
      expect(suite.onEvent(completedTool(`call-${index}`, { command: 'status' }, `result-${index}`)).failure).toBeUndefined();
    }
  });

  it('同一 terminal 再送を無視し、矛盾 terminal は protocol anomaly にする', () => {
    const suite = resolveOpenCodeGuardSuite(undefined, 'opencode/big-pickle');
    const first = completedTool('call-1', { filePath: 'a.ts' }, 'first');
    expect(suite.onEvent(first).failure).toBeUndefined();
    expect(suite.onEvent(first).anomalies).toEqual([]);

    const contradictory = suite.onEvent(completedTool('call-1', { filePath: 'a.ts' }, 'second'));
    expect(contradictory.failure).toBeUndefined();
    expect(contradictory.anomalies).toMatchObject([{ guardId: 'tool-protocol' }]);
  });

  it('tombstone は受信 tool 名を完全一致比較し、反復 key とは分離する', () => {
    const suite = resolveOpenCodeGuardSuite(undefined, 'opencode/big-pickle');
    expect(suite.onEvent(completedTool('call-name', {}, 'same', { tool: 'read' })).anomalies).toEqual([]);
    expect(suite.onEvent(completedTool('call-name', {}, 'same', { tool: ' READ ' })).anomalies)
      .toMatchObject([{ guardId: 'tool-protocol' }]);
  });

  it('canonical hash は object key 順序に依存せず input/result を domain separation する', () => {
    expect(computeToolInputHash({ b: 2, a: 1 })).toBe(computeToolInputHash({ a: 1, b: 2 }));
    expect(computeToolInputHash('same')).not.toBe(computeToolResultHash('same'));
  });

  it('canonicalization 不能な入力は反復ストリーク対象外にする', () => {
    const suite = resolveOpenCodeGuardSuite(undefined, 'opencode/big-pickle');
    const input: Record<string, unknown> = {};
    input.self = input;
    for (let index = 0; index < 20; index += 1) {
      expect(suite.onEvent(completedTool(`call-${index}`, input, 'same')).failure).toBeUndefined();
    }
  });

  it('cycle は messageID を重複排除し、成功 callID の terminal でリセットする', () => {
    process.env.TAKT_OPENCODE_MESSAGE_CYCLE_BUDGET = '3';
    const suite = resolveOpenCodeGuardSuite(undefined, 'opencode/big-pickle');
    expect(suite.onEvent(completedMessage('message-1')).failure).toBeUndefined();
    expect(suite.onEvent(completedMessage('message-1')).failure).toBeUndefined();
    expect(suite.onEvent(completedMessage('message-2')).failure).toBeUndefined();
    expect(suite.onEvent(completedTool('call-success', {}, 'ok')).failure).toBeUndefined();
    expect(suite.onEvent(completedMessage('message-3')).failure).toBeUndefined();
    expect(suite.onEvent(completedMessage('message-4')).failure).toBeUndefined();
    expect(suite.onEvent(completedMessage('message-5')).failure).toMatchObject({ guardId: 'cycle-budget' });
  });

  it('cycle budget は attempt 境界を越えて持ち越さない', () => {
    process.env.TAKT_OPENCODE_MESSAGE_CYCLE_BUDGET = '3';
    const suite = resolveOpenCodeGuardSuite(undefined, 'opencode/big-pickle');
    suite.startAttempt(() => undefined);
    expect(suite.onEvent(completedMessage('first-1')).failure).toBeUndefined();
    expect(suite.onEvent(completedMessage('first-2')).failure).toBeUndefined();
    suite.stopAttempt();

    suite.startAttempt(() => undefined);
    expect(suite.onEvent(completedMessage('second-1')).failure).toBeUndefined();
    expect(suite.onEvent(completedMessage('second-2')).failure).toBeUndefined();
    expect(suite.onEvent(completedMessage('second-3')).failure).toMatchObject({ guardId: 'cycle-budget' });
    suite.stopAttempt();
  });

  it('strict loop は minimal でも有効で correction 用の型付き失敗を返す', () => {
    const suite = resolveOpenCodeGuardSuite({ profile: 'minimal' }, 'opencode/big-pickle');
    const message = "Model tried to call unavailable tool 'run'";
    expect(suite.onEvent(errorTool('call-1', 'run', message)).failure).toBeUndefined();
    const failure = suite.onEvent(errorTool('call-2', 'run', message)).failure;
    expect(failure).toMatchObject({
      guardId: 'exact-loop',
      recoveryFailure: { kind: 'unavailable_tool_loop', tool: 'run' },
    });
  });

  it('strict loop の観測済み callID は attempt 境界で破棄する', () => {
    const policy = resolveOpenCodeGuardSuite(undefined, 'opencode/big-pickle').policy;
    const guard = new ExactLoopGuard(policy);
    const message = "Model tried to call unavailable tool 'run'";

    guard.start('attempt');
    expect(guard.onEvent(errorTool('shared-call', 'run', message))).toBeUndefined();
    guard.start('attempt');
    expect(guard.onEvent(errorTool('shared-call', 'run', message))).toBeUndefined();
    expect(guard.onEvent(errorTool('next-call', 'run', message))).toMatchObject({
      action: 'fail',
      reason: expect.stringContaining('unavailable tool loop'),
    });
  });

  it('sensitive budget の未設定 exhaust reason は unknown として分類可能な接頭辞を保つ', () => {
    const sensitiveValues = createBoundedSensitiveValues();
    sensitiveValues.exhaust();
    const guard = new SensitiveBudgetGuard(sensitiveValues);

    expect(guard.onInitialSource({})).toEqual({
      action: 'fail',
      reason: 'OpenCode sensitive value budget exceeded: unknown',
    });
  });

  it('tool input hash は sensitive budget guard だけが保持し terminal と attempt で解放する', () => {
    const sensitiveValues = createBoundedSensitiveValues();
    const collect = vi.spyOn(sensitiveValues, 'collect');
    const guard = new SensitiveBudgetGuard(sensitiveValues);
    const toolEvent = (status: 'pending' | 'running' | 'completed'): OpenCodeStreamEvent => ({
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'part-1',
          sessionID: 'session-1',
          type: 'tool',
          callID: 'call-1',
          tool: 'read',
          state: status === 'completed'
            ? { status, input: { path: 'a.ts' }, output: 'ok', title: 'read' }
            : { status, input: { path: 'a.ts' } },
        },
      },
    });

    guard.start('attempt');
    guard.onEvent(toolEvent('running'));
    guard.onEvent(toolEvent('running'));
    guard.onEvent(toolEvent('completed'));
    expect(collect).toHaveBeenCalledTimes(1);

    guard.onEvent(toolEvent('pending'));
    expect(collect).toHaveBeenCalledTimes(2);
    guard.start('attempt');
    guard.onEvent(toolEvent('pending'));
    expect(collect).toHaveBeenCalledTimes(3);
  });

  it('consecutive-errors は standard で発火し minimal では選択されない', () => {
    process.env.TAKT_OPENCODE_TOOL_ERROR_CONSECUTIVE = '3';
    process.env.TAKT_OPENCODE_TOOL_ERROR_WINDOW = '20';
    const standard = resolveOpenCodeGuardSuite(undefined, 'opencode/big-pickle');
    const minimal = resolveOpenCodeGuardSuite({ profile: 'minimal' }, 'opencode/big-pickle');
    for (let index = 1; index <= 2; index += 1) {
      expect(standard.onEvent(errorTool(`s-${index}`, `tool-${index}`, `failure-${index}`)).failure).toBeUndefined();
      expect(minimal.onEvent(errorTool(`m-${index}`, `tool-${index}`, `failure-${index}`)).failure).toBeUndefined();
    }
    expect(standard.onEvent(errorTool('s-3', 'tool-3', 'failure-3')).failure).toMatchObject({
      guardId: 'consecutive-errors',
    });
    expect(minimal.onEvent(errorTool('m-3', 'tool-3', 'failure-3')).failure).toBeUndefined();
  });

  it('wall-clock は call scope 全体で発火する', () => {
    vi.useFakeTimers();
    const suite = resolveOpenCodeGuardSuite({ callTimeoutMs: 60_000 }, 'opencode/big-pickle');
    const failures: string[] = [];
    suite.startCall((failure) => failures.push(failure.guardId));
    vi.advanceTimersByTime(59_999);
    expect(failures).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(failures).toEqual(['wall-clock']);
    suite.stopCall();
  });

  it('idle-timeout はツール実行外の無音では従来どおり発火する', () => {
    vi.useFakeTimers();
    process.env.TAKT_OPENCODE_STREAM_IDLE_TIMEOUT_MS = '60000';
    const suite = resolveOpenCodeGuardSuite(undefined, 'opencode/big-pickle');
    const failures: string[] = [];
    suite.startAttempt((failure) => failures.push(failure.guardId));

    vi.advanceTimersByTime(59_999);
    expect(failures).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(failures).toEqual(['idle-timeout']);
    suite.stopAttempt();
  });

  it('idle-timeout は in-flight ツールがある間は発火せず、結果受信で再開する', () => {
    vi.useFakeTimers();
    process.env.TAKT_OPENCODE_STREAM_IDLE_TIMEOUT_MS = '60000';
    const suite = resolveOpenCodeGuardSuite(undefined, 'opencode/big-pickle');
    const failures: string[] = [];
    suite.startAttempt((failure) => failures.push(failure.guardId));

    const input = { command: 'npm run test:it' };
    expect(suite.onEvent(runningTool('call-1', input)).failure).toBeUndefined();
    vi.advanceTimersByTime(5 * 60_000);
    expect(failures).toEqual([]);

    expect(suite.onEvent(completedTool('call-1', input, 'passed', { tool: 'bash' })).failure)
      .toBeUndefined();
    vi.advanceTimersByTime(59_999);
    expect(failures).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(failures).toEqual(['idle-timeout']);
    suite.stopAttempt();
  });

  it('idle-timeout は並行ツールが1つでも in-flight なら停止したままになる', () => {
    vi.useFakeTimers();
    process.env.TAKT_OPENCODE_STREAM_IDLE_TIMEOUT_MS = '60000';
    const suite = resolveOpenCodeGuardSuite(undefined, 'opencode/big-pickle');
    const failures: string[] = [];
    suite.startAttempt((failure) => failures.push(failure.guardId));

    const first = { command: 'npm run test:it' };
    const second = { command: 'npm run test:e2e:mock' };
    suite.onEvent(runningTool('call-1', first));
    suite.onEvent(runningTool('call-2', second));
    suite.onEvent(completedTool('call-1', first, 'passed', { tool: 'bash' }));
    vi.advanceTimersByTime(5 * 60_000);
    expect(failures).toEqual([]);

    suite.onEvent(completedTool('call-2', second, 'passed', { tool: 'bash' }));
    vi.advanceTimersByTime(60_000);
    expect(failures).toEqual(['idle-timeout']);
    suite.stopAttempt();
  });

  it('idle-timeout は error 終端でも計測を再開する', () => {
    vi.useFakeTimers();
    process.env.TAKT_OPENCODE_STREAM_IDLE_TIMEOUT_MS = '60000';
    const suite = resolveOpenCodeGuardSuite(undefined, 'opencode/big-pickle');
    const failures: string[] = [];
    suite.startAttempt((failure) => failures.push(failure.guardId));

    suite.onEvent(runningTool('call-1', { command: 'npm run test:it' }));
    vi.advanceTimersByTime(5 * 60_000);
    expect(failures).toEqual([]);

    suite.onEvent(errorTool('call-1', 'bash', 'command failed', { command: 'npm run test:it' }));
    vi.advanceTimersByTime(59_999);
    expect(failures).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(failures).toEqual(['idle-timeout']);
    suite.stopAttempt();
  });

  it('idle-timeout は terminal を取りこぼした in-flight を stale として捨て、劣化を有界にする', () => {
    vi.useFakeTimers();
    process.env.TAKT_OPENCODE_STREAM_IDLE_TIMEOUT_MS = '60000';
    const suite = resolveOpenCodeGuardSuite(undefined, 'opencode/big-pickle');
    const failures: string[] = [];
    suite.startAttempt((failure) => failures.push(failure.guardId));

    // terminal イベントが来ないまま無音が続く（取りこぼし）。
    suite.onEvent(runningTool('call-1', { command: 'npm run test:it' }));
    vi.advanceTimersByTime(6 * 60_000 - 1);
    expect(failures).toEqual([]);

    // stale 期限で in-flight を捨て、そこから通常のアイドル計測が再開する。
    vi.advanceTimersByTime(1);
    expect(failures).toEqual([]);
    vi.advanceTimersByTime(59_999);
    expect(failures).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(failures).toEqual(['idle-timeout']);
    suite.stopAttempt();
  });

  it('終端イベントが来ないツールは wall-clock が拾う', () => {
    vi.useFakeTimers();
    process.env.TAKT_OPENCODE_STREAM_IDLE_TIMEOUT_MS = '60000';
    const suite = resolveOpenCodeGuardSuite({ callTimeoutMs: 60_000 }, 'opencode/big-pickle');
    const failures: string[] = [];
    suite.startCall((failure) => failures.push(failure.guardId));
    suite.startAttempt((failure) => failures.push(failure.guardId));

    suite.onEvent(runningTool('call-1', { command: 'npm run test:it' }));
    vi.advanceTimersByTime(59_999);
    expect(failures).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(failures).toEqual(['wall-clock']);
    expect(suite.getCallFailure()).toMatchObject({ guardId: 'wall-clock' });
    suite.stopAttempt();
    suite.stopCall();
  });

  it.each([
    ['object でない part', undefined],
    ['null の part', null],
    ['文字列の part', 'tool'],
    ['state を欠く tool part', { type: 'tool', tool: 'bash', callID: 'call-1' }],
    ['state が null の tool part', { type: 'tool', tool: 'bash', callID: 'call-1', state: null }],
    ['status を欠く tool part', {
      type: 'tool',
      tool: 'bash',
      callID: 'call-1',
      state: { input: {} },
    }],
    ['tool 名を欠く tool part', {
      type: 'tool',
      callID: 'call-1',
      state: { status: 'running', input: {} },
    }],
    ['呼び出し識別子を欠く tool part', {
      type: 'tool',
      tool: 'bash',
      state: { status: 'running', input: {} },
    }],
  ])('%s は tool part として読まない', (_label, part) => {
    const event = {
      type: 'message.part.updated',
      properties: { sessionID: 'session-1', part },
    } as OpenCodeStreamEvent;

    expect(readOpenCodeToolPart(event)).toBeUndefined();
  });

  it('必要なフィールドが揃った tool part は読み取れる', () => {
    expect(readOpenCodeToolPart(runningTool('call-1', { command: 'ls' })))
      .toMatchObject({ type: 'tool', tool: 'bash', callID: 'call-1' });
  });

  it('idle-timeout の in-flight は attempt 境界で持ち越さない', () => {
    vi.useFakeTimers();
    process.env.TAKT_OPENCODE_STREAM_IDLE_TIMEOUT_MS = '60000';
    const suite = resolveOpenCodeGuardSuite(undefined, 'opencode/big-pickle');
    const failures: string[] = [];
    suite.startAttempt(() => undefined);
    suite.onEvent(runningTool('call-1', { command: 'npm run test:it' }));
    suite.stopAttempt();

    suite.startAttempt((failure) => failures.push(failure.guardId));
    vi.advanceTimersByTime(60_000);
    expect(failures).toEqual(['idle-timeout']);
    suite.stopAttempt();
  });

  it('新しい call deadline guard はレジストリ登録だけで共通 abort 契約に参加する', () => {
    const additionalTimeGuard: OpenCodeGuardDescriptor = {
      id: 'registry-only-deadline',
      layer: 'time',
      mandatory: true,
      create: () => ({
        id: 'registry-only-deadline',
        layer: 'time',
        start: (scope, onVerdict) => {
          if (scope !== 'call') return;
          onVerdict({
            action: 'fail',
            reason: 'registered deadline reached',
            abortKind: 'deadline',
          });
        },
      }),
    };
    const suite = resolveOpenCodeGuardSuite(
      undefined,
      'opencode/big-pickle',
      [...OPENCODE_GUARD_REGISTRY, additionalTimeGuard],
    );
    const abortController = new AbortController();

    suite.startCall((failure) => {
      if (failure.verdict.abortKind !== undefined) {
        abortController.abort(new Error(failure.verdict.reason));
      }
    });

    expect(suite.enabledGuardIds).toContain('registry-only-deadline');
    expect(suite.getCallFailure()).toMatchObject({
      guardId: 'registry-only-deadline',
      verdict: { abortKind: 'deadline' },
    });
    expect(abortController.signal.aborted).toBe(true);
    expect(abortController.signal.reason).toEqual(new Error('registered deadline reached'));
    suite.stopCall();
  });

  it('reasoning guard は上限ちょうどを受理し +1 byte で失敗する', () => {
    const suite = resolveOpenCodeGuardSuite(undefined, 'opencode/big-pickle');
    const reasoningEvent = (delta: string): OpenCodeStreamEvent => ({
      type: 'message.part.delta',
      properties: {
        sessionID: 'session-1',
        partID: 'reasoning-1',
        field: 'text',
        delta,
        guardPartType: 'reasoning',
      },
    } as OpenCodeStreamEvent);

    expect(suite.onEvent(reasoningEvent('x'.repeat(4 * 1024 * 1024))).failure).toBeUndefined();
    expect(suite.onEvent(reasoningEvent('x')).failure).toMatchObject({ guardId: 'reasoning-volume' });
  });

  it.each(['text', 'reasoning'] as const)(
    '%s volume guard は同一 snapshot の再送を新規出力として課金しない',
    (partType) => {
      const suite = resolveOpenCodeGuardSuite({
        profile: 'minimal',
        textByteLimit: 5,
        reasoningByteLimit: 5,
      }, 'opencode/big-pickle');
      const snapshot = (text: string): OpenCodeStreamEvent => ({
        type: 'message.part.updated',
        properties: {
          part: { id: `${partType}-1`, sessionID: 'session-1', type: partType, text },
        },
      } as OpenCodeStreamEvent);

      expect(suite.onEvent(snapshot('12345')).failure).toBeUndefined();
      expect(suite.onEvent(snapshot('12345')).failure).toBeUndefined();
      expect(suite.onEvent(snapshot('123456')).failure).toMatchObject({
        guardId: `${partType}-volume`,
      });
    },
  );

  it('廃止済み tool guard env は値を無視して各変数につき一度だけ警告する', () => {
    const deprecated = DEPRECATED_ENV_KEYS;
    for (const key of deprecated) process.env[key] = '1';
    const emitWarning = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);

    resolveOpenCodeGuardSuite(undefined, 'opencode/model-1');
    resolveOpenCodeGuardSuite(undefined, 'opencode/model-2');

    expect(emitWarning).toHaveBeenCalledTimes(deprecated.length);
    for (const key of deprecated) {
      expect(emitWarning).toHaveBeenCalledWith(
        expect.stringContaining(key),
        expect.objectContaining({ code: 'TAKT_DEPRECATED_OPENCODE_GUARD_ENV' }),
      );
    }
    emitWarning.mockRestore();
  });
});

describe('ToolGuardRecoveryState', () => {
  it('correction 予算を種別間で共有し、同じ fingerprint を再発行しない', () => {
    let state = createToolGuardRecoveryState(2);
    expect(shouldIssueToolGuardCorrection(state, 'unavailable:run')).toBe(true);
    state = markToolGuardCorrectionPending(state, 'session-1', 'unavailable:run', 'Use a valid tool.');
    expect(shouldIssueToolGuardCorrection(state, 'unavailable:run')).toBe(false);
    expect(shouldIssueToolGuardCorrection(state, 'invalid:read')).toBe(true);
    state = markToolGuardCorrectionPending(state, 'session-1', 'invalid:read', 'Use valid arguments.');
    expect(shouldIssueToolGuardCorrection(state, 'edit:signature')).toBe(false);
  });
});
