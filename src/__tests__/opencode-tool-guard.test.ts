/**
 * OpenCode tool ガード（tool-guard.ts）の単体テスト。
 *
 * v3-r4 実測（implement が25ツールエラーで abort、うち19件が edit の幻覚
 * oldString、14分半に散発・間に成功多数 = 空転ではない）と、導入動機の
 * 559スピン（プロバイダ劣化・成功ゼロ・26分空転）の両方を材料に、
 * 進捗感知型 burst / edit conflict / 絶対コスト上限の分離を固定する。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OpenCodeToolGuard,
  computeEditConflictSignature,
  type ToolGuardFailure,
} from '../infra/opencode/tool-guard.js';
import { parseServerAvailableTools } from '../infra/opencode/unavailable-tool-recovery.js';
import { startTimerPump } from './helpers/opencode-client-test-helpers.js';

const ENV_KEYS = [
  'TAKT_OPENCODE_TOOL_ERROR_BUDGET',
  'TAKT_OPENCODE_TOOL_SIGNATURE_ABSOLUTE',
  'TAKT_OPENCODE_TOOL_ERROR_WINDOW',
  'TAKT_OPENCODE_TOOL_ERROR_WINDOW_RATE',
  'TAKT_OPENCODE_TOOL_ERROR_CONSECUTIVE',
  'TAKT_OPENCODE_TOOL_SIGNATURE_REPEATS',
  'TAKT_OPENCODE_TOOL_SUCCESS_REPEATS',
  'TAKT_OPENCODE_TOOL_RESULT_STAGNATION_REPEATS',
  'TAKT_OPENCODE_EDIT_CONFLICT_REPEATS',
] as const;

afterEach(() => {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
});

let callSeq = 0;
function nextCallId(): string {
  callSeq += 1;
  return `call-${callSeq}`;
}

/** 毎回異なる署名のエラー（ツール名とメッセージを変える）。 */
function distinctError(guard: OpenCodeToolGuard, index: number): ToolGuardFailure | undefined {
  return guard.observeError(nextCallId(), `tool-${index % 5}`, `some failure variant ${index}`);
}

function editError(guard: OpenCodeToolGuard, filePath: string, oldString: string): ToolGuardFailure | undefined {
  return guard.observeError(nextCallId(), 'edit', 'oldString not found in content', { filePath, oldString });
}

function success(
  guard: OpenCodeToolGuard,
  tool: string,
  input: unknown,
  output: unknown,
  callId = nextCallId(),
): ToolGuardFailure | undefined {
  return guard.observeSuccess(callId, tool, input, output);
}

describe('OpenCodeToolGuard: 成功結果反復', () => {
  it('A, B, A, B, A の交互実行でも A が閾値3に達すると tool_success_loop になる', () => {
    process.env.TAKT_OPENCODE_TOOL_SUCCESS_REPEATS = '3';
    const guard = new OpenCodeToolGuard();
    expect(success(guard, 'bash', { command: 'git diff -- a.ts' }, 'same output')).toBeUndefined();
    expect(success(guard, 'bash', { command: 'git diff -- b.ts' }, 'same output')).toBeUndefined();
    expect(success(guard, 'bash', { command: 'git diff -- a.ts' }, 'same output')).toBeUndefined();
    expect(success(guard, 'bash', { command: 'git diff -- b.ts' }, 'same output')).toBeUndefined();
    const failure = success(guard, 'bash', { command: 'git diff -- a.ts' }, 'same output');
    expect(failure?.kind).toBe('tool_success_loop');
    expect(failure?.message).not.toContain('git diff');
    expect(failure?.message).not.toContain('same output');
  });

  it('同じ入力でも結果が変われば反復数を1へ戻す', () => {
    process.env.TAKT_OPENCODE_TOOL_SUCCESS_REPEATS = '3';
    const guard = new OpenCodeToolGuard();
    expect(success(guard, 'read', { filePath: 'src/a.ts' }, 'before')).toBeUndefined();
    expect(success(guard, 'read', { filePath: 'src/a.ts' }, 'before')).toBeUndefined();
    expect(success(guard, 'read', { filePath: 'src/a.ts' }, 'after')).toBeUndefined();
    expect(success(guard, 'read', { filePath: 'src/a.ts' }, 'after')).toBeUndefined();
  });

  it('timeout、filePath、offset、limit の差を別入力として扱う', () => {
    process.env.TAKT_OPENCODE_TOOL_SUCCESS_REPEATS = '2';
    const guard = new OpenCodeToolGuard();
    const inputs = [
      { command: 'git diff', timeout: 10 },
      { command: 'git diff', timeout: 20 },
      { filePath: 'src/a.ts', offset: 0, limit: 10 },
      { filePath: 'src/a.ts', offset: 10, limit: 10 },
      { filePath: 'src/a.ts', offset: 0, limit: 20 },
    ];
    for (const input of inputs) {
      expect(success(guard, 'read', input, 'result')).toBeUndefined();
    }
  });

  it('入力のオブジェクトキー順だけが異なる成功は同一入力として扱う', () => {
    process.env.TAKT_OPENCODE_TOOL_SUCCESS_REPEATS = '2';
    const guard = new OpenCodeToolGuard();
    expect(success(guard, 'read', {
      filePath: 'src/a.ts',
      options: { offset: 0, range: { end: 10, start: 0 } },
    }, 'result')).toBeUndefined();
    expect(success(guard, 'READ', {
      options: { range: { start: 0, end: 10 }, offset: 0 },
      filePath: 'src/a.ts',
    }, 'result')?.kind).toBe('tool_success_loop');
  });

  it('edit 成功は成功反復台帳をクリアする', () => {
    process.env.TAKT_OPENCODE_TOOL_SUCCESS_REPEATS = '3';
    const guard = new OpenCodeToolGuard();
    const input = { command: 'git diff -- src/a.ts' };
    expect(success(guard, 'bash', input, 'same')).toBeUndefined();
    expect(success(guard, 'bash', input, 'same')).toBeUndefined();
    expect(success(guard, 'edit', { filePath: 'src/a.ts' }, 'changed')).toBeUndefined();
    expect(success(guard, 'bash', input, 'same')).toBeUndefined();
    expect(success(guard, 'bash', input, 'same')).toBeUndefined();
  });

  it('同じ completed callID の非隣接再送を二重計数しない', () => {
    process.env.TAKT_OPENCODE_TOOL_SUCCESS_REPEATS = '3';
    const guard = new OpenCodeToolGuard();
    const repeatedCallId = nextCallId();
    expect(success(guard, 'bash', { command: 'git diff' }, 'same', repeatedCallId)).toBeUndefined();
    expect(success(guard, 'bash', { command: 'git diff -- src/a.ts' }, 'same')).toBeUndefined();
    expect(success(guard, 'bash', { command: 'git diff' }, 'same', repeatedCallId)).toBeUndefined();
    expect(success(guard, 'bash', { command: 'git diff' }, 'same')).toBeUndefined();
    expect(guard.stats().totalSuccesses).toBe(3);
  });

  it('同じ session ID の reset は成功台帳と completed callID の重複排除を保持する', () => {
    process.env.TAKT_OPENCODE_TOOL_SUCCESS_REPEATS = '2';
    const guard = new OpenCodeToolGuard();
    const repeatedCallId = nextCallId();
    guard.resetSessionCounters('session-1');
    expect(success(guard, 'bash', { command: 'git diff' }, 'same', repeatedCallId)).toBeUndefined();
    guard.resetSessionCounters('session-1');
    expect(success(guard, 'bash', { command: 'git diff' }, 'same', repeatedCallId)).toBeUndefined();
    expect(success(guard, 'bash', { command: 'git diff' }, 'same')?.kind).toBe('tool_success_loop');
  });

  it('別 session ID の reset は成功台帳と completed callID の重複排除をクリアする', () => {
    process.env.TAKT_OPENCODE_TOOL_SUCCESS_REPEATS = '2';
    const guard = new OpenCodeToolGuard();
    const repeatedCallId = nextCallId();
    guard.resetSessionCounters('session-1');
    expect(success(guard, 'bash', { command: 'git diff' }, 'same', repeatedCallId)).toBeUndefined();
    guard.resetSessionCounters('session-2');
    expect(success(guard, 'bash', { command: 'git diff' }, 'same', repeatedCallId)).toBeUndefined();
    expect(success(guard, 'bash', { command: 'git diff' }, 'same')?.kind).toBe('tool_success_loop');
  });

  it('結果変化または write 進捗を挟む反復は閾値を超えても停止しない', () => {
    process.env.TAKT_OPENCODE_TOOL_SUCCESS_REPEATS = '3';
    const guard = new OpenCodeToolGuard();
    const input = { filePath: 'src/a.ts' };
    for (let index = 0; index < 8; index += 1) {
      expect(success(guard, 'read', input, `result-${index}`)).toBeUndefined();
    }
    expect(success(guard, 'read', input, 'stable')).toBeUndefined();
    expect(success(guard, 'read', input, 'stable')).toBeUndefined();
    expect(success(guard, 'write', { filePath: 'src/a.ts' }, 'written')).toBeUndefined();
    expect(success(guard, 'read', input, 'stable')).toBeUndefined();
    expect(success(guard, 'read', input, 'stable')).toBeUndefined();
  });
});

describe('OpenCodeToolGuard: tool_result_stagnation', () => {
  function failedResult(
    guard: OpenCodeToolGuard,
    tool: string,
    input: unknown,
    output: unknown,
    callId = nextCallId(),
  ): ToolGuardFailure | undefined {
    return guard.observeToolResultStagnation(callId, tool, input, output);
  }

  it('同一の失敗結果は edit 成功を挟んでも12回目で停止し、11回では停止しない', () => {
    const guard = new OpenCodeToolGuard();
    const input = { command: 'verify' };
    for (let index = 0; index < 11; index += 1) {
      expect(failedResult(guard, 'bash', input, 'verification failed')).toBeUndefined();
      expect(success(guard, 'edit', { filePath: 'src/a.ts' }, 'changed')).toBeUndefined();
    }
    guard.resetSessionCounters('session-1');
    guard.resetSessionCounters('session-2');
    expect(failedResult(guard, 'bash', input, 'verification failed')?.kind).toBe('tool_result_stagnation');
  });

  it('同じ入力でも output が変われば反復数を1へ戻す', () => {
    process.env.TAKT_OPENCODE_TOOL_RESULT_STAGNATION_REPEATS = '3';
    const guard = new OpenCodeToolGuard();
    const input = { command: 'verify' };
    expect(failedResult(guard, 'bash', input, 'failure A')).toBeUndefined();
    expect(failedResult(guard, 'bash', input, 'failure A')).toBeUndefined();
    expect(failedResult(guard, 'bash', input, 'failure B')).toBeUndefined();
    expect(failedResult(guard, 'bash', input, 'failure B')).toBeUndefined();
  });

  it('同じキーが意味上の成功になれば停滞台帳から消える', () => {
    process.env.TAKT_OPENCODE_TOOL_RESULT_STAGNATION_REPEATS = '3';
    const guard = new OpenCodeToolGuard();
    const input = { command: 'verify' };
    expect(failedResult(guard, 'bash', input, 'failure')).toBeUndefined();
    expect(failedResult(guard, 'bash', input, 'failure')).toBeUndefined();
    guard.clearToolResultStagnation('bash', input);
    expect(failedResult(guard, 'bash', input, 'failure')).toBeUndefined();
    expect(failedResult(guard, 'bash', input, 'failure')).toBeUndefined();
  });

  it('別 input は別の停滞台帳として扱う', () => {
    process.env.TAKT_OPENCODE_TOOL_RESULT_STAGNATION_REPEATS = '2';
    const guard = new OpenCodeToolGuard();
    expect(failedResult(guard, 'bash', { command: 'verify A' }, 'failure')).toBeUndefined();
    expect(failedResult(guard, 'bash', { command: 'verify B' }, 'failure')).toBeUndefined();
  });

  it('同じ callID の再送は停滞回数へ二重計上しない', () => {
    process.env.TAKT_OPENCODE_TOOL_RESULT_STAGNATION_REPEATS = '2';
    const guard = new OpenCodeToolGuard();
    const callId = nextCallId();
    expect(failedResult(guard, 'bash', { command: 'verify' }, 'failure', callId)).toBeUndefined();
    expect(failedResult(guard, 'bash', { command: 'verify' }, 'failure', callId)).toBeUndefined();
    expect(failedResult(guard, 'bash', { command: 'verify' }, 'failure')).toMatchObject({ kind: 'tool_result_stagnation' });
  });

  it('別 session で再利用された callID は同じ失敗結果として計上する', () => {
    process.env.TAKT_OPENCODE_TOOL_RESULT_STAGNATION_REPEATS = '2';
    const guard = new OpenCodeToolGuard();
    const callId = 'call-1';
    const input = { command: 'verify' };

    guard.resetSessionCounters('session-1');
    expect(failedResult(guard, 'bash', input, 'failure', callId)).toBeUndefined();
    guard.resetSessionCounters('session-2');
    expect(failedResult(guard, 'bash', input, 'failure', callId)?.kind).toBe('tool_result_stagnation');
  });
});

describe('OpenCodeToolGuard: 進捗感知型 burst', () => {
  it('559スピン型（成功なしの連続失敗）は旧25発火より速く（既定10連続で）tool_error_burst になる', () => {
    const guard = new OpenCodeToolGuard();
    let failure: ToolGuardFailure | undefined;
    let fired = 0;
    for (let index = 1; index <= 25; index += 1) {
      failure = distinctError(guard, index);
      if (failure !== undefined) {
        fired = index;
        break;
      }
    }
    expect(failure?.kind).toBe('tool_error_burst');
    // 旧 ToolErrorBudgetDetector の発火（25）と同等以上の速さ。
    expect(fired).toBeLessThanOrEqual(25);
    expect(fired).toBe(10);
    if (failure?.kind === 'tool_error_burst') {
      expect(failure.stats.maxConsecutiveErrors).toBe(10);
      expect(failure.stats.totalSuccesses).toBe(0);
    }
  });

  it('v3-r4 実測型（散発エラー・間に強い進捗多数）は 25 エラーを越えても burst にならない', () => {
    const guard = new OpenCodeToolGuard();
    // 2エラー → bash 成功（強い進捗 = 短期リセット）を14回 = エラー28件。
    // 署名はすべて異なる（幻覚 oldString はファイル・内容が毎回違う）。
    for (let round = 0; round < 14; round += 1) {
      for (let sub = 0; sub < 2; sub += 1) {
        const failure = editError(guard, `src/file-${round}.ts`, `hallucinated old string ${round}-${sub}`);
        expect(failure).toBeUndefined();
      }
      guard.observeSuccess(nextCallId(), 'bash', {}, 'progress');
    }
    const stats = guard.stats();
    expect(stats.totalErrors).toBe(28);
    expect(stats.totalSuccesses).toBe(14);
  });

  it('弱い進捗（read 成功）は短期密度を緩和するが、強い進捗（write 成功）だけが連続カウンタを完全リセットする', () => {
    // 弱い進捗: 9エラー → read 成功（連続 9→4）→ 5エラー（→9）はまだ burst でない。
    const weak = new OpenCodeToolGuard();
    for (let index = 1; index <= 9; index += 1) {
      expect(distinctError(weak, index)).toBeUndefined();
    }
    weak.observeSuccess(nextCallId(), 'read', {}, 'progress');
    for (let index = 10; index <= 14; index += 1) {
      expect(distinctError(weak, index)).toBeUndefined();
    }
    // 次のエラーで連続10到達 → burst。
    expect(distinctError(weak, 15)?.kind).toBe('tool_error_burst');

    // 強い進捗: 9エラー → write 成功 → 9エラーでも burst にならない。
    const strong = new OpenCodeToolGuard();
    for (let index = 1; index <= 9; index += 1) {
      expect(distinctError(strong, index)).toBeUndefined();
    }
    strong.observeSuccess(nextCallId(), 'write', {}, 'progress');
    for (let index = 10; index <= 18; index += 1) {
      expect(distinctError(strong, index)).toBeUndefined();
    }
  });

  it('直近ウィンドウのエラー率でも burst を検出する（連続閾値に達しない散発高密度）', () => {
    // 連続閾値を退避して密度経路だけを検証する。
    process.env.TAKT_OPENCODE_TOOL_ERROR_CONSECUTIVE = '100';
    const guard = new OpenCodeToolGuard();
    // 9エラー → read 成功 → 9エラー → read 成功 → 窓20が満杯（エラー18/20 = 90%）。
    let failure: ToolGuardFailure | undefined;
    for (let index = 1; index <= 9 && failure === undefined; index += 1) {
      failure = distinctError(guard, index);
    }
    guard.observeSuccess(nextCallId(), 'read', {}, 'progress');
    for (let index = 10; index <= 18 && failure === undefined; index += 1) {
      failure = distinctError(guard, index);
    }
    expect(failure).toBeUndefined();
    guard.observeSuccess(nextCallId(), 'read', {}, 'progress');
    // 窓が満杯になった後の次のエラーで率超過が見える。
    failure = distinctError(guard, 19);
    expect(failure?.kind).toBe('tool_error_burst');
    if (failure?.kind === 'tool_error_burst') {
      expect(failure.stats.recentErrorRate).toBeGreaterThanOrEqual(0.9);
    }
  });

  it('非 edit ツールの同一エラー署名の反復（既定8）でも burst になる', () => {
    // 連続閾値より先に署名反復で発火することを確認するため、成功を挟んで
    // 連続カウンタを抑える。
    const guard = new OpenCodeToolGuard();
    let failure: ToolGuardFailure | undefined;
    for (let index = 1; index <= 8 && failure === undefined; index += 1) {
      failure = guard.observeError(nextCallId(), 'bash', 'command not found: pnpm');
      if (index % 3 === 0) {
        guard.observeSuccess(nextCallId(), 'read', {}, 'progress');
      }
    }
    expect(failure?.kind).toBe('tool_error_burst');
  });
});

describe('OpenCodeToolGuard: 強い進捗とウィンドウ（codex ブロッカー1の回帰）', () => {
  it('9エラー → bash成功 → 9エラー → bash成功 → 1エラー が誤 burst にならない（率計算は強い進捗を跨がない）', () => {
    const guard = new OpenCodeToolGuard();
    for (let index = 1; index <= 9; index += 1) {
      expect(distinctError(guard, index)).toBeUndefined();
    }
    guard.observeSuccess(nextCallId(), 'bash', {}, 'progress');
    for (let index = 10; index <= 18; index += 1) {
      expect(distinctError(guard, index)).toBeUndefined();
    }
    guard.observeSuccess(nextCallId(), 'bash', {}, 'progress');
    // 旧実装はここでウィンドウ20件中エラー18件（90%）を満たして burst していた。
    expect(distinctError(guard, 19)).toBeUndefined();
    // 絶対台帳は維持されている（消えるのは短期ウィンドウだけ）。
    expect(guard.stats().totalErrors).toBe(19);
  });

  it('弱い進捗（read 成功）はウィンドウを消さない（密度検出は維持される）', () => {
    process.env.TAKT_OPENCODE_TOOL_ERROR_CONSECUTIVE = '100';
    const guard = new OpenCodeToolGuard();
    for (let index = 1; index <= 9; index += 1) {
      expect(distinctError(guard, index)).toBeUndefined();
    }
    guard.observeSuccess(nextCallId(), 'read', {}, 'progress');
    for (let index = 10; index <= 18; index += 1) {
      expect(distinctError(guard, index)).toBeUndefined();
    }
    guard.observeSuccess(nextCallId(), 'read', {}, 'progress');
    // 弱い進捗しか無い高密度エラーは率経路で burst になる。
    expect(distinctError(guard, 19)?.kind).toBe('tool_error_burst');
  });
});

describe('ToolGuardRecoveryState: correction fingerprint の共有予算', () => {
  it('種別をまたいでも同じ上限を使い、同じ fingerprint の correction は一度だけにする', async () => {
    const { createToolGuardRecoveryState, markToolGuardCorrectionPending, shouldIssueToolGuardCorrection } = await import('../infra/opencode/tool-guard.js');
    let state = createToolGuardRecoveryState();
    expect(shouldIssueToolGuardCorrection(state, 'unavailable:run')).toBe(true);
    state = markToolGuardCorrectionPending(state, 'session-1', 'unavailable:run', 'Use a valid tool.');
    expect(shouldIssueToolGuardCorrection(state, 'unavailable:run')).toBe(false);
    expect(shouldIssueToolGuardCorrection(state, 'invalid:read')).toBe(true);
    state = markToolGuardCorrectionPending(state, 'session-1', 'invalid:read', 'Use valid arguments.');
    expect(state.correctionsUsed).toBe(2);
    expect(shouldIssueToolGuardCorrection(state, 'edit:sig-c')).toBe(false);
  });
});

describe('OpenCodeToolGuard: edit_conflict_loop', () => {
  it('同一 filePath + oldString の失敗が既定3回反復すると edit_conflict_loop になる（署名はハッシュのみ露出）', () => {
    const guard = new OpenCodeToolGuard();
    expect(editError(guard, 'src/a.ts', 'the same wrong old string')).toBeUndefined();
    expect(editError(guard, 'src/a.ts', 'the same wrong old string')).toBeUndefined();
    const failure = editError(guard, 'src/a.ts', 'the same wrong old string');
    expect(failure?.kind).toBe('edit_conflict_loop');
    if (failure?.kind === 'edit_conflict_loop') {
      expect(failure.filePath).toBe('src/a.ts');
      expect(failure.signature).toBe(computeEditConflictSignature('src/a.ts', 'the same wrong old string'));
      // oldString の本文はメッセージに残さない。
      expect(failure.message).not.toContain('the same wrong old string');
      expect(failure.message).toContain(failure.signature.slice(0, 12));
    }
  });

  it('oldString が毎回異なる edit 失敗は edit_conflict_loop にならない', () => {
    const guard = new OpenCodeToolGuard();
    for (let index = 0; index < 5; index += 1) {
      expect(editError(guard, 'src/a.ts', `different old string ${index}`)).toBeUndefined();
    }
  });

  it('強い進捗（edit 成功）は同一署名の短期反復をリセットする', () => {
    const guard = new OpenCodeToolGuard();
    expect(editError(guard, 'src/a.ts', 'wrong span')).toBeUndefined();
    expect(editError(guard, 'src/a.ts', 'wrong span')).toBeUndefined();
    guard.observeSuccess(nextCallId(), 'edit', {}, 'progress');
    // リセット後は再び閾値までの猶予がある。
    expect(editError(guard, 'src/a.ts', 'wrong span')).toBeUndefined();
    expect(editError(guard, 'src/a.ts', 'wrong span')).toBeUndefined();
    expect(editError(guard, 'src/a.ts', 'wrong span')?.kind).toBe('edit_conflict_loop');
  });
});

describe('OpenCodeToolGuard: 絶対コスト上限（recovery をまたぐ台帳）', () => {
  it('unavailable detector と総エラー上限が同時成立したら absolute hard stop を優先する', () => {
    process.env.TAKT_OPENCODE_TOOL_ERROR_BUDGET = '2';
    const guard = new OpenCodeToolGuard();
    const message = "Model tried to call unavailable tool 'run'";

    expect(guard.observeError(nextCallId(), 'run', message)).toBeUndefined();
    const failure = guard.observeError(nextCallId(), 'run', message);

    expect(failure?.kind).toBe('absolute_cost_limit');
    if (failure?.kind === 'absolute_cost_limit') {
      expect(failure.stats.totalErrors).toBe(2);
      expect(failure.stats.recoveriesUsed).toBe(0);
    }
  });

  it('invalid-argument detector と総エラー上限が同時成立したら absolute hard stop を優先する', () => {
    process.env.TAKT_OPENCODE_TOOL_ERROR_BUDGET = '4';
    const guard = new OpenCodeToolGuard();
    const message = "Required argument 'filePath' is missing or invalid";
    let failure: ToolGuardFailure | undefined;

    for (let index = 0; index < 4; index += 1) {
      failure = guard.observeError(nextCallId(), 'read', message);
    }

    expect(failure?.kind).toBe('absolute_cost_limit');
    if (failure?.kind === 'absolute_cost_limit') {
      expect(failure.stats.totalErrors).toBe(4);
      expect(failure.stats.recoveriesUsed).toBe(0);
    }
  });

  it('エラー総数の絶対上限は resetSessionCounters()（fresh-session recovery）でリセットされない', () => {
    process.env.TAKT_OPENCODE_TOOL_ERROR_BUDGET = '12';
    const guard = new OpenCodeToolGuard();
    let failure: ToolGuardFailure | undefined;
    // セッション1: 成功を挟みつつ 6 エラー（burst には達しない）。
    for (let index = 1; index <= 6; index += 1) {
      failure = distinctError(guard, index);
      expect(failure).toBeUndefined();
      guard.observeSuccess(nextCallId(), 'bash', {}, 'progress');
    }
    // fresh-session recovery 相当。
    guard.resetSessionCounters('session-2');
    guard.noteRecovery();
    // セッション2: さらに 6 エラーで絶対上限 12 に到達する。
    for (let index = 7; index <= 12 && failure === undefined; index += 1) {
      failure = distinctError(guard, index);
      if (failure === undefined) {
        guard.observeSuccess(nextCallId(), 'bash', {}, 'progress');
      }
    }
    expect(failure?.kind).toBe('absolute_cost_limit');
    if (failure?.kind === 'absolute_cost_limit') {
      expect(failure.stats.totalErrors).toBe(12);
      expect(failure.stats.recoveriesUsed).toBe(1);
      expect(failure.message).toContain('absolute tool error budget');
    }
  });

  it('同一署名の絶対反復上限も recovery をまたいで維持される', () => {
    process.env.TAKT_OPENCODE_TOOL_SIGNATURE_ABSOLUTE = '5';
    const guard = new OpenCodeToolGuard();
    // セッション1: 同一署名 2 回（edit 閾値3未満）。
    expect(editError(guard, 'src/a.ts', 'stubborn span')).toBeUndefined();
    expect(editError(guard, 'src/a.ts', 'stubborn span')).toBeUndefined();
    guard.resetSessionCounters('session-2');
    // セッション2: 短期は 0 から数え直すが、絶対署名台帳は 3,4,5 と進む。
    expect(editError(guard, 'src/a.ts', 'stubborn span')).toBeUndefined();
    expect(editError(guard, 'src/a.ts', 'stubborn span')).toBeUndefined();
    const failure = editError(guard, 'src/a.ts', 'stubborn span');
    expect(failure?.kind).toBe('absolute_cost_limit');
    if (failure?.kind === 'absolute_cost_limit') {
      expect(failure.message).toContain('same-signature');
    }
  });
});

describe('OpenCodeToolGuard: 既存検出器の統合（ロジック不変）', () => {
  it('存在しないツールの連続呼び出し（閾値2）は unavailable_tool_loop としてツール名つきで返る', () => {
    const guard = new OpenCodeToolGuard();
    expect(guard.observeError(nextCallId(), 'run', "Model tried to call unavailable tool 'run'")).toBeUndefined();
    const failure = guard.observeError(nextCallId(), 'run', "Model tried to call unavailable tool 'run'");
    expect(failure?.kind).toBe('unavailable_tool_loop');
    if (failure?.kind === 'unavailable_tool_loop') {
      expect(failure.tool).toBe('run');
    }
  });

  it('同一ツールへの引数エラー連発（閾値4）は invalid_argument_loop として返る', () => {
    const guard = new OpenCodeToolGuard();
    for (let index = 0; index < 3; index += 1) {
      expect(guard.observeError(nextCallId(), 'read', "Required argument 'filePath' is missing or invalid")).toBeUndefined();
    }
    const failure = guard.observeError(nextCallId(), 'read', "Required argument 'filePath' is missing or invalid");
    expect(failure?.kind).toBe('invalid_argument_loop');
    if (failure?.kind === 'invalid_argument_loop') {
      expect(failure.tool).toBe('read');
    }
  });

  it('テキスト活動は unavailable 検出器の連続性だけを切る（既存挙動の維持）', () => {
    const guard = new OpenCodeToolGuard();
    expect(guard.observeError(nextCallId(), 'run', "Model tried to call unavailable tool 'run'")).toBeUndefined();
    guard.noteTextActivity();
    // テキストを挟むと unavailable の連続性が切れ、2回目でも発火しない。
    expect(guard.observeError(nextCallId(), 'run', "Model tried to call unavailable tool 'run'")).toBeUndefined();
  });

  it('同一 callId の重複イベントは1回として数える', () => {
    const guard = new OpenCodeToolGuard();
    const callId = nextCallId();
    for (let index = 0; index < 30; index += 1) {
      expect(guard.observeError(callId, 'bash', 'boom')).toBeUndefined();
    }
    expect(guard.stats().totalErrors).toBe(1);
  });
});

describe('parseServerAvailableTools', () => {
  it('parses the server-reported list and excludes the internal invalid pseudo-tool', () => {
    const message = "Model tried to call unavailable tool 'list'. Available tools: bash, edit, glob, grep, invalid, read, skill, todowrite, webfetch, write.";
    expect(parseServerAvailableTools(message)).toEqual([
      'bash', 'edit', 'glob', 'grep', 'read', 'skill', 'todowrite', 'webfetch', 'write',
    ]);
  });

  it('excludes the invalid pseudo-tool case-insensitively', () => {
    expect(parseServerAvailableTools('Available tools: bash, Invalid, read.')).toEqual(['bash', 'read']);
    expect(parseServerAvailableTools('Available tools: bash, INVALID, read.')).toEqual(['bash', 'read']);
  });

  // codex 実測の崩れ形式3つ: 部分一致の切り詰めや壊れトークンを
  // 解析成功と誤認せず、列挙全体を破棄して undefined に倒す。
  it('rejects malformed enumerations wholesale instead of mis-parsing them', () => {
    expect(parseServerAvailableTools('Available tools: foo.bar, read.')).toBeUndefined();
    expect(parseServerAvailableTools('Available tools: bash; read.')).toBeUndefined();
    expect(parseServerAvailableTools('Available tools: none.')).toBeUndefined();
  });

  it('returns undefined for messages without an Available tools enumeration', () => {
    expect(parseServerAvailableTools('Model tried to call unavailable tool "x".')).toBeUndefined();
    expect(parseServerAvailableTools('')).toBeUndefined();
    expect(parseServerAvailableTools('Available tools: .')).toBeUndefined();
  });
});


// ---------------------------------------------------------------------------
// OpenCodeClient の tool-guard recovery オーケストレーション配線
// （旧 opencode-client-tool-guard.test.ts。guard 状態機械そのものの検証は
// 上の単体 describe 群が担い、ここは client 経由でしか通らない配線
// — metadata.exit の解釈、correction / fresh recovery、AgentResponse.error の
// マスク — だけを扱う。opencode-client-retry.test.ts と同じ SDK モック機構。）
//
// - edit_conflict_loop → 同一セッション内 correction 1回 → 再発で fresh session
//   recovery 1回 → done
// - tool_error_burst → 同一セッション内 correction 1回 → 再発で fresh session
//   recovery 1回 → 再発で即失敗
// - absolute_cost_limit → 即失敗（recovery なし）
// ---------------------------------------------------------------------------

type MockStreamEvent = Record<string, unknown>;

let runPlans: MockStreamEvent[][] = [];
let runPlanIndex = 0;

function createEvents(events: MockStreamEvent[], sessionId: string) {
  return (async function* () {
    for (const event of events) {
      const properties = event.properties;
      if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
        throw new Error('Mock OpenCode event properties are required');
      }
      yield { ...event, properties: { ...properties, sessionID: sessionId } };
    }
  })();
}

const { createOpencodeMock } = vi.hoisted(() => ({
  createOpencodeMock: vi.fn(),
}));

vi.mock('node:net', () => ({
  createServer: () => {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    return {
      unref: vi.fn(),
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        handlers.set(event, handler);
      }),
      listen: vi.fn((_port: number, _host: string, cb: () => void) => {
        cb();
      }),
      address: vi.fn(() => ({ port: 62000 })),
      close: vi.fn((cb?: (err?: Error) => void) => cb?.()),
    };
  },
}));

vi.mock('@opencode-ai/sdk/v2', () => ({
  createOpencode: createOpencodeMock,
}));

const { OpenCodeClient, resetSharedServer } = await import('../infra/opencode/client.js');

let sessionSeq = 0;

function installOpenCodeMock() {
  let activeSessionId: string | undefined;
  const sessionCreate = vi.fn().mockImplementation(async () => {
    sessionSeq += 1;
    activeSessionId = `session-${sessionSeq}`;
    return { data: { id: activeSessionId } };
  });
  const promptAsync = vi.fn().mockResolvedValue(undefined);
  const abort = vi.fn().mockResolvedValue({ data: true });
  const subscribe = vi.fn().mockImplementation(async () => {
    const plan = runPlans[runPlanIndex];
    runPlanIndex += 1;
    if (!plan) {
      throw new Error(`Missing run plan for attempt ${runPlanIndex}`);
    }
    if (activeSessionId === undefined) {
      throw new Error('OpenCode session must be created before subscribing');
    }
    return { stream: createEvents(plan, activeSessionId) };
  });

  createOpencodeMock.mockResolvedValue({
    client: {
      instance: { dispose: vi.fn() },
      session: { create: sessionCreate, promptAsync, abort },
      event: { subscribe },
      permission: { reply: vi.fn() },
    },
    server: { close: vi.fn() },
  });

  return { sessionCreate, promptAsync, abort, subscribe };
}

let toolCallSeq = 0;

function editErrorEvent(filePath: string, oldString: string): MockStreamEvent {
  toolCallSeq += 1;
  return {
    type: 'message.part.updated',
    properties: {
      part: {
        id: `part-${toolCallSeq}`,
        type: 'tool',
        tool: 'edit',
        callID: `tc-${toolCallSeq}`,
        state: {
          status: 'error',
          error: 'oldString not found in content',
          input: { filePath, oldString, newString: 'replacement' },
        },
      },
    },
  };
}

function genericErrorEvent(index: number): MockStreamEvent {
  toolCallSeq += 1;
  return {
    type: 'message.part.updated',
    properties: {
      part: {
        id: `part-${toolCallSeq}`,
        type: 'tool',
        tool: `tool-${index % 4}`,
        callID: `tc-${toolCallSeq}`,
        state: { status: 'error', error: `provider degradation failure ${index}`, input: {} },
      },
    },
  };
}

function bodyErrorEvent(tool: string, key: string, body: string, index: number): MockStreamEvent {
  toolCallSeq += 1;
  return {
    type: 'message.part.updated',
    properties: {
      part: {
        id: `part-${toolCallSeq}`,
        type: 'tool',
        tool,
        callID: `tc-${toolCallSeq}`,
        state: {
          status: 'error',
          error: `Tool failure ${index} quoted body:\n${body}`,
          input: { filePath: `src/file-${index}.ts`, [key]: body },
        },
      },
    },
  };
}

function sensitiveErrorEvent(input: Record<string, unknown>, error: string): MockStreamEvent {
  toolCallSeq += 1;
  return {
    type: 'message.part.updated',
    properties: {
      part: {
        id: `part-${toolCallSeq}`,
        type: 'tool',
        tool: 'fetch',
        callID: `tc-${toolCallSeq}`,
        state: { status: 'error', error, input },
      },
    },
  };
}

function shortSecretInvalidArgumentEvent(): MockStreamEvent {
  toolCallSeq += 1;
  return {
    type: 'message.part.updated',
    properties: {
      part: {
        id: `part-${toolCallSeq}`,
        type: 'tool',
        tool: 'read',
        callID: `tc-${toolCallSeq}`,
        state: {
          status: 'error',
          error: 'Invalid arguments: token "a"',
          input: { token: 'a' },
        },
      },
    },
  };
}

function completedToolEvent(
  tool: string,
  input: Record<string, unknown>,
  output: string,
  callID?: string,
  metadata?: Record<string, unknown>,
): MockStreamEvent {
  toolCallSeq += 1;
  return {
    type: 'message.part.updated',
    properties: {
      part: {
        id: `part-${toolCallSeq}`,
        type: 'tool',
        tool,
        callID: callID ?? `tc-${toolCallSeq}`,
        state: {
          status: 'completed',
          input,
          output,
          title: tool,
          ...(metadata !== undefined ? { metadata } : {}),
        },
      },
    },
  };
}

function invalidCompletedToolEvent(): MockStreamEvent {
  toolCallSeq += 1;
  return {
    type: 'message.part.updated',
    properties: {
      part: {
        id: `part-${toolCallSeq}`,
        type: 'tool',
        tool: 'invalid',
        callID: `tc-${toolCallSeq}`,
        state: {
          status: 'completed',
          input: {
            tool: 'read',
            error: `Required argument 'filePath' is missing or invalid (variant ${'x'.repeat(toolCallSeq)})`,
          },
          output: 'OpenCode rejected the tool call',
          title: 'invalid',
        },
      },
    },
  };
}

function successEvents(sessionId: string, text: string): MockStreamEvent[] {
  return [
    {
      type: 'message.part.updated',
      properties: { part: { id: 'p-done', type: 'text', text }, delta: text },
    },
    { type: 'session.idle', properties: { sessionID: sessionId } },
  ];
}

describe('OpenCodeClient tool guard recovery', () => {
  // correction / fresh recovery の retry backoff（実時間 250-500ms）を
  // fake timers のポンプで実時間ゼロに圧縮する。アサーションは同一。
  let pump: { stop: () => Promise<void> };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    resetSharedServer();
    runPlans = [];
    runPlanIndex = 0;
    sessionSeq = 0;
    toolCallSeq = 0;
    pump = startTimerPump(20);
  });

  afterEach(async () => {
    await pump.stop();
    delete process.env.TAKT_OPENCODE_TOOL_ERROR_BUDGET;
    delete process.env.TAKT_OPENCODE_TOOL_SUCCESS_REPEATS;
    delete process.env.TAKT_OPENCODE_TOOL_RESULT_STAGNATION_REPEATS;
  });

  it('completed の成功反復は recovery や transient retry をせず1回の prompt で error になる', async () => {
    process.env.TAKT_OPENCODE_TOOL_SUCCESS_REPEATS = '3';
    runPlans = [[
      completedToolEvent('bash', { command: 'git diff -- src/a.ts' }, 'unchanged'),
      completedToolEvent('bash', { command: 'git diff -- src/b.ts' }, 'unchanged'),
      completedToolEvent('bash', { command: 'git diff -- src/a.ts' }, 'unchanged'),
      completedToolEvent('bash', { command: 'git diff -- src/b.ts' }, 'unchanged'),
      completedToolEvent('bash', { command: 'git diff -- src/a.ts' }, 'unchanged'),
    ]];

    const { sessionCreate, promptAsync } = installOpenCodeMock();
    const client = new OpenCodeClient();
    const result = await client.call('coder', 'implement the task', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });

    expect(result.status).toBe('error');
    expect(result.error).toContain('successful tool result loop');
    expect(result.error).not.toContain('git diff');
    expect(result.error).not.toContain('unchanged');
    expect(promptAsync).toHaveBeenCalledTimes(1);
    expect(sessionCreate).toHaveBeenCalledTimes(1);
  });

  it.each([1, null])('metadata.exit=%s の同一結果は edit 成功を挟んでも12回目で terminal error になり、本文を漏らさず recovery しない', async (exit) => {
    const sensitiveInput = 'verify --token secret-input-body';
    const sensitiveOutput = 'verification failed: secret-output-body';
    runPlans = [[
      ...Array.from({ length: 12 }, () => [
        completedToolEvent('bash', { command: sensitiveInput }, sensitiveOutput, undefined, { exit }),
        completedToolEvent('edit', { filePath: 'src/a.ts' }, 'changed', undefined, { exit: 0 }),
      ]).flat(),
    ]];

    const { sessionCreate, promptAsync } = installOpenCodeMock();
    const client = new OpenCodeClient();
    const result = await client.call('coder', 'implement the task', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });

    expect(result.status).toBe('error');
    expect(result.error).toContain('tool result stagnation');
    expect(result.error).not.toContain(sensitiveInput);
    expect(result.error).not.toContain(sensitiveOutput);
    expect(promptAsync).toHaveBeenCalledTimes(1);
    expect(sessionCreate).toHaveBeenCalledTimes(1);
  });

  it('metadata.exit=0 は同じキーの結果停滞を消去する', async () => {
    process.env.TAKT_OPENCODE_TOOL_RESULT_STAGNATION_REPEATS = '3';
    const input = { command: 'verify' };
    runPlans = [[
      completedToolEvent('bash', input, 'failed', undefined, { exit: 1 }),
      completedToolEvent('bash', input, 'failed', undefined, { exit: 1 }),
      completedToolEvent('bash', input, 'passed', undefined, { exit: 0 }),
      completedToolEvent('bash', input, 'failed', undefined, { exit: 1 }),
      completedToolEvent('bash', input, 'failed', undefined, { exit: 1 }),
      ...successEvents('never', 'done').slice(0, 1),
      { type: 'session.idle', properties: {} },
    ]];

    installOpenCodeMock();
    const client = new OpenCodeClient();
    const result = await client.call('coder', 'implement the task', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });

    expect(result.status).toBe('done');
  });

  it('metadata 欠落または exit 型不正の completed は従来どおり成功として扱う', async () => {
    process.env.TAKT_OPENCODE_TOOL_SUCCESS_REPEATS = '2';
    runPlans = [[
      completedToolEvent('bash', { command: 'verify' }, 'unchanged'),
      completedToolEvent('bash', { command: 'verify' }, 'unchanged', undefined, { exit: '1' }),
    ]];

    installOpenCodeMock();
    const client = new OpenCodeClient();
    const result = await client.call('coder', 'implement the task', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });

    expect(result.status).toBe('error');
    expect(result.error).toContain('successful tool result loop');
    expect(result.error).not.toContain('tool result stagnation');
  });

  it('completed invalid は成功台帳へ入れず既存の引数エラー検出へ流れる', async () => {
    process.env.TAKT_OPENCODE_TOOL_SUCCESS_REPEATS = '2';
    const invalidLoop = () => [
      invalidCompletedToolEvent(),
      invalidCompletedToolEvent(),
      invalidCompletedToolEvent(),
      invalidCompletedToolEvent(),
    ];
    runPlans = [invalidLoop(), invalidLoop(), invalidLoop()];

    const { sessionCreate, promptAsync } = installOpenCodeMock();
    const client = new OpenCodeClient();
    const result = await client.call('coder', 'implement the task', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });

    expect(result.status).toBe('error');
    expect(result.error).toContain('invalid');
    expect(result.error).not.toContain('successful tool result loop');
    expect(promptAsync).toHaveBeenCalledTimes(3);
    expect(sessionCreate).toHaveBeenCalledTimes(2);
  });

  it('同一 session の correction attempt をまたいで成功反復を数える', async () => {
    process.env.TAKT_OPENCODE_TOOL_SUCCESS_REPEATS = '3';
    runPlans = [
      [
        completedToolEvent('bash', { command: 'git diff -- src/a.ts' }, 'unchanged'),
        completedToolEvent('bash', { command: 'git diff -- src/a.ts' }, 'unchanged'),
        editErrorEvent('src/target.ts', 'stubborn wrong span'),
        editErrorEvent('src/target.ts', 'stubborn wrong span'),
        editErrorEvent('src/target.ts', 'stubborn wrong span'),
      ],
      [
        completedToolEvent('bash', { command: 'git diff -- src/a.ts' }, 'unchanged'),
      ],
    ];

    const { sessionCreate, promptAsync } = installOpenCodeMock();
    const client = new OpenCodeClient();
    const result = await client.call('coder', 'implement the task', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });

    expect(result.status).toBe('error');
    expect(result.error).toContain('successful tool result loop');
    expect(promptAsync).toHaveBeenCalledTimes(2);
    expect(sessionCreate).toHaveBeenCalledTimes(1);
    const calls = promptAsync.mock.calls.map((call) => call[0] as { sessionID: string });
    expect(calls[0]?.sessionID).toBe('session-1');
    expect(calls[1]?.sessionID).toBe('session-1');
  });

  it('edit conflict: 同一セッション correction 1回 → 再発で fresh session 1回 → 成功で done', async () => {
    runPlans = [
      // attempt1 (session-1): 同一署名 edit エラー ×3 → edit_conflict_loop。
      [
        editErrorEvent('src/target.ts', 'stubborn wrong span'),
        editErrorEvent('src/target.ts', 'stubborn wrong span'),
        editErrorEvent('src/target.ts', 'stubborn wrong span'),
      ],
      // attempt2 (correction、session-1 を再開): 是正しても同一署名 ×3。
      [
        editErrorEvent('src/target.ts', 'stubborn wrong span'),
        editErrorEvent('src/target.ts', 'stubborn wrong span'),
        editErrorEvent('src/target.ts', 'stubborn wrong span'),
      ],
      // attempt3 (fresh session、session-2): 成功。
      successEvents('session-2', 'recovered and finished'),
    ];

    const { sessionCreate, promptAsync } = installOpenCodeMock();
    const client = new OpenCodeClient();
    const result = await client.call('coder', 'implement the task', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });

    expect(result.status).toBe('done');
    expect(result.content).toBe('recovered and finished');
    expect(promptAsync).toHaveBeenCalledTimes(3);

    // attempt1: 新規セッション。attempt2: correction は同一セッション再開
    // （create は呼ばれない）。attempt3: fresh session。
    expect(sessionCreate).toHaveBeenCalledTimes(2);
    const call1 = promptAsync.mock.calls[0]?.[0] as { sessionID: string; parts: Array<{ text: string }> };
    const call2 = promptAsync.mock.calls[1]?.[0] as { sessionID: string; parts: Array<{ text: string }> };
    const call3 = promptAsync.mock.calls[2]?.[0] as { sessionID: string; parts: Array<{ text: string }> };
    expect(call1.sessionID).toBe('session-1');
    expect(call2.sessionID).toBe('session-1');
    expect(call3.sessionID).toBe('session-2');

    // correction は元プロンプトを再送せず、再読込・同一 oldString 反復禁止の
    // 是正指示のみ。oldString の本文は含めない。
    expect(call2.parts[0]?.text).toContain('Re-read');
    expect(call2.parts[0]?.text).toContain('src/target.ts');
    expect(call2.parts[0]?.text).not.toContain('stubborn wrong span');
    expect(call2.parts[0]?.text).not.toContain('implement the task');

    // fresh session は途中成果の上書き禁止を明記した前置文 + 元プロンプト。
    expect(call3.parts[0]?.text).toContain('partially completed work');
    expect(call3.parts[0]?.text).toContain('Do NOT overwrite');
    expect(call3.parts[0]?.text).toContain('implement the task');

    // 観測: tool health が応答に構造化されて残る。
    const toolHealth = (result.debugInfo as { toolHealth?: { totalErrors: number; recoveriesUsed: number } })?.toolHealth;
    expect(toolHealth?.totalErrors).toBe(6);
    expect(toolHealth?.recoveriesUsed).toBe(2);
  });

  it('correction 中の別署名 conflict は新しい conflict として自身の correction から始まり、共有 fresh recovery を消費しない（codex ブロッカー2）', async () => {
    runPlans = [
      // attempt1 (session-1): 署名A ×3 → correction(A)。
      [
        editErrorEvent('src/alpha.ts', 'wrong span alpha'),
        editErrorEvent('src/alpha.ts', 'wrong span alpha'),
        editErrorEvent('src/alpha.ts', 'wrong span alpha'),
      ],
      // attempt2 (correction A、session-1 再開): 今度は別ファイルの別署名B ×3。
      // 旧実装はこれを「correction 済みの再発」と誤同一視して fresh を消費していた。
      [
        editErrorEvent('src/beta.ts', 'wrong span beta'),
        editErrorEvent('src/beta.ts', 'wrong span beta'),
        editErrorEvent('src/beta.ts', 'wrong span beta'),
      ],
      // attempt3 (correction B、session-1 再開): 署名B が再発 → correction 失敗
      // → fresh へ escalate。
      [
        editErrorEvent('src/beta.ts', 'wrong span beta'),
        editErrorEvent('src/beta.ts', 'wrong span beta'),
        editErrorEvent('src/beta.ts', 'wrong span beta'),
      ],
      // attempt4 (fresh、session-2): 成功。
      successEvents('session-2', 'finally done'),
    ];

    const { sessionCreate, promptAsync } = installOpenCodeMock();
    const client = new OpenCodeClient();
    const result = await client.call('coder', 'implement the task', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });

    expect(result.status).toBe('done');
    expect(promptAsync).toHaveBeenCalledTimes(4);
    expect(sessionCreate).toHaveBeenCalledTimes(2);
    const calls = promptAsync.mock.calls.map((call) => call[0] as { sessionID: string; parts: Array<{ text: string }> });
    // attempt2 は署名A（src/alpha.ts）の correction、attempt3 は署名B（src/beta.ts）の
    // 新しい correction — fresh ではなく同一セッション再開。
    expect(calls[1]?.sessionID).toBe('session-1');
    expect(calls[1]?.parts[0]?.text).toContain('src/alpha.ts');
    expect(calls[2]?.sessionID).toBe('session-1');
    expect(calls[2]?.parts[0]?.text).toContain('src/beta.ts');
    expect(calls[2]?.parts[0]?.text).toContain('Re-read');
    // attempt4 が唯一の fresh recovery。
    expect(calls[3]?.sessionID).toBe('session-2');
    expect(calls[3]?.parts[0]?.text).toContain('partially completed work');
  });

  it('correction / fresh recovery を使い切った後の失敗応答（AgentResponse.error）にも oldString 本文が露出しない', async () => {
    // correction 上限（既定2）と fresh（1）をすべて edit conflict で消費させる。
    const conflictBatch = (file: string, span: string) => [
      editErrorEvent(file, span),
      editErrorEvent(file, span),
      editErrorEvent(file, span),
    ];
    runPlans = [
      conflictBatch('src/alpha.ts', 'secret-looking source body ALPHA'), // → correction(A)
      conflictBatch('src/alpha.ts', 'secret-looking source body ALPHA'), // 再発 → fresh
      conflictBatch('src/alpha.ts', 'secret-looking source body ALPHA'), // fresh でも再発 → 失敗
    ];

    const { promptAsync } = installOpenCodeMock();
    const client = new OpenCodeClient();
    const result = await client.call('coder', 'implement the task', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });

    expect(result.status).toBe('error');
    expect(promptAsync).toHaveBeenCalledTimes(3);
    // 失敗メッセージは署名ハッシュと filePath のみで、oldString 本文を含まない。
    expect(result.error).toContain('edit conflict loop');
    expect(result.error).toContain('src/alpha.ts');
    expect(result.error).not.toContain('secret-looking source body ALPHA');
  });

  it('tool_error_burst: correction → fresh session → 再発で即失敗（needs_fix 等への迂回はしない）', async () => {
    runPlans = [
      // attempt1: 連続10エラー（559スピン型）→ burst。
      [...Array.from({ length: 10 }, (_, index) => genericErrorEvent(index))],
      // attempt2 (correction): また連続10エラー → 同じ fingerprint の再発で fresh。
      [...Array.from({ length: 10 }, (_, index) => genericErrorEvent(index + 10))],
      // attempt3 (fresh): 再発 → recovery 消費済みで失敗。
      [...Array.from({ length: 10 }, (_, index) => genericErrorEvent(index + 20))],
    ];

    const { sessionCreate, promptAsync } = installOpenCodeMock();
    const client = new OpenCodeClient();
    const result = await client.call('coder', 'implement the task', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });

    expect(result.status).toBe('error');
    expect(result.error).toContain('tool error burst');
    expect(promptAsync).toHaveBeenCalledTimes(3);
    expect(sessionCreate).toHaveBeenCalledTimes(2);
    const call2 = promptAsync.mock.calls[1]?.[0] as { parts: Array<{ text: string }> };
    const call3 = promptAsync.mock.calls[2]?.[0] as { parts: Array<{ text: string }> };
    expect(call2.parts[0]?.text).toContain('tool calls are failing repeatedly');
    expect(call2.parts[0]?.text).not.toContain('implement the task');
    expect(call3.parts[0]?.text).toContain('degraded into a burst');
    expect(call3.parts[0]?.text).toContain('implement the task');

    // 絶対台帳は recovery をまたいで維持されている。
    const toolHealth = (result.debugInfo as { toolHealth?: { totalErrors: number; recoveriesUsed: number } })?.toolHealth;
    expect(toolHealth?.totalErrors).toBe(30);
    expect(toolHealth?.recoveriesUsed).toBe(2);
  });

  it('エラー文が oldString 本文を引用しても failureMessage（AgentResponse.error）に本文が現れない（codex 2巡目ブロッカー: エラー文経由の漏えい）', async () => {
    process.env.TAKT_OPENCODE_TOOL_ERROR_BUDGET = '5';
    const longOldString = 'const secretLookingSnippet = computeInternalThing(privateValue); // quoted verbatim by the opencode edit error';
    // OpenCode の edit エラー文は oldString の内容を含むことがある
    // （Could not find... の詳細部分）。入力側のマスクだけでは閉じない。
    const editErrorQuotingBody = (index: number): MockStreamEvent => {
      toolCallSeq += 1;
      return {
        type: 'message.part.updated',
        properties: {
          part: {
            id: `part-${toolCallSeq}`,
            type: 'tool',
            tool: 'edit',
            callID: `tc-${toolCallSeq}`,
            state: {
              status: 'error',
              error: `Could not find the following text in src/f${index}.ts:\n${longOldString}`,
              input: { filePath: `src/f${index}.ts`, oldString: longOldString, newString: 'replacement' },
            },
          },
        },
      };
    };
    // filePath を変えて edit_conflict（同一署名）を避け、絶対上限5で即失敗させる。
    // absolute_cost_limit の message は最後のエラー文を連結する経路（codex 再演）。
    runPlans = [[0, 1, 2, 3, 4].map((index) => editErrorQuotingBody(index))];

    const { promptAsync } = installOpenCodeMock();
    const client = new OpenCodeClient();
    const result = await client.call('coder', 'implement the task', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });

    expect(result.status).toBe('error');
    expect(result.error).toContain('absolute tool error budget');
    expect(promptAsync).toHaveBeenCalledTimes(1);
    // エラー文に引用された oldString 本文は {sha256 先頭12桁, length} に
    // 置換され、failureMessage には現れない。
    expect(result.error).not.toContain(longOldString);
    expect(result.error).not.toContain('secretLookingSnippet');
    expect(result.error).toMatch(/\{sha256:[0-9a-f]{12},length:\d+\}/);
  });

  it.each([
    ['write', 'content', 'complete source body quoted by write failure'],
    ['apply_patch', 'patchText', 'patch body quoted by apply_patch failure'],
  ])('guard の最終 AgentResponse.error に %s.%s 本文を残さない', async (tool, key, body) => {
    process.env.TAKT_OPENCODE_TOOL_ERROR_BUDGET = '5';
    runPlans = [[0, 1, 2, 3, 4].map((index) => bodyErrorEvent(tool, key, body, index))];
    installOpenCodeMock();
    const client = new OpenCodeClient();

    const result = await client.call('coder', 'implement the task', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });

    expect(result.status).toBe('error');
    expect(result.error).toContain('absolute tool error budget');
    expect(result.error).not.toContain(body);
    expect(result.error).toMatch(/\{sha256:[0-9a-f]{12},length:\d+\}/);
  });

  it('guard の最終 AgentResponse.error に HTTP/session 機密値を再流出させない', async () => {
    process.env.TAKT_OPENCODE_TOOL_ERROR_BUDGET = '1';
    const secrets = {
      proxyAuthorization: 'Basic proxy-credential-secret',
      cookies: 'sid=cookie-value-secret',
      sessionId: 'provider-session-value-secret',
    };
    runPlans = [[sensitiveErrorEvent({
      'Proxy-Authorization': secrets.proxyAuthorization,
      cookies: secrets.cookies,
      sessionId: secrets.sessionId,
    }, `provider rejected ${secrets.proxyAuthorization}; ${secrets.cookies}; ${secrets.sessionId}`)]];

    installOpenCodeMock();
    const client = new OpenCodeClient();
    const result = await client.call('coder', 'implement the task', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });

    expect(result.status).toBe('error');
    expect(result.error).toContain('absolute tool error budget');
    expect(result.error).not.toContain(secrets.proxyAuthorization);
    expect(result.error).not.toContain(secrets.cookies);
    expect(result.error).not.toContain(secrets.sessionId);
  });

  it('short secrets do not prevent invalid-argument loop detection', async () => {
    runPlans = [
      [
        shortSecretInvalidArgumentEvent(),
        shortSecretInvalidArgumentEvent(),
        shortSecretInvalidArgumentEvent(),
        shortSecretInvalidArgumentEvent(),
      ],
      successEvents('unused', 'recovered'),
    ];

    const { promptAsync } = installOpenCodeMock();
    const client = new OpenCodeClient();
    const result = await client.call('coder', 'implement the task', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });

    expect(result.status).toBe('done');
    expect(promptAsync).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(promptAsync.mock.calls)).not.toContain('token "a"');
  });

  it('absolute_cost_limit: 即失敗し recovery は使われない', async () => {
    process.env.TAKT_OPENCODE_TOOL_ERROR_BUDGET = '5';
    runPlans = [
      // 成功を挟んで burst を避けつつ、絶対上限5に到達させる。
      [
        genericErrorEvent(0),
        ...successEvents('never', 'x').slice(0, 1), // text のみ（idle は最後）
        genericErrorEvent(1),
        genericErrorEvent(2),
        genericErrorEvent(3),
        genericErrorEvent(4),
      ],
    ];

    const { promptAsync } = installOpenCodeMock();
    const client = new OpenCodeClient();
    const result = await client.call('coder', 'implement the task', {
      cwd: '/tmp',
      model: 'opencode/big-pickle',
    });

    expect(result.status).toBe('error');
    expect(result.error).toContain('absolute tool error budget');
    // recovery attempt は発生しない。
    expect(promptAsync).toHaveBeenCalledTimes(1);
  });
});
