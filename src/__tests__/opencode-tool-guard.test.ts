/**
 * OpenCode tool ガード（tool-guard.ts）の単体テスト。
 *
 * v3-r4 実測（implement が25ツールエラーで abort、うち19件が edit の幻覚
 * oldString、14分半に散発・間に成功多数 = 空転ではない）と、導入動機の
 * 559スピン（プロバイダ劣化・成功ゼロ・26分空転）の両方を材料に、
 * 進捗感知型 burst / edit conflict / 絶対コスト上限の分離を固定する。
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  OpenCodeToolGuard,
  computeEditConflictSignature,
  type ToolGuardFailure,
} from '../infra/opencode/tool-guard.js';

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
