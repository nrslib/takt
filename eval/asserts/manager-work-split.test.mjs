import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import evaluate from './manager-work-split.mjs';
import { loadManagerCase, managerWriteSchemas } from '../manager-work-split-prompt.mjs';

const selectedKeys = {
  'parallel-cli': ['users-command', 'jobs-command', 'storage-command'],
  'parallel-docs-migration': ['search-doc', 'export-doc', 'billing-migration'],
  'shared-resource': ['web-permissions'],
  'shared-definition': ['resolve-assignment'],
  'human-order': ['migration-a'],
  'constraint-carryover': ['resolve-assignment'],
  'constraint-carryover-data': ['channel-totals'],
  'constraint-once': ['ping-log', 'users-paging'],
  'integration-check': [],
  'escalate-repeated-failure': ['admin-copy'],
  'escalate-not-on-first-failure': ['csv-import'],
  'no-check-docs': [],
  'no-check-same-module': [],
  'integration-already-checked': [],
  'summary-keeps-constraint': [],
  'summary-keeps-constraint-web': [],
  'summary-no-invented-constraint': [],
  'mail-dispatch-state': [],
  'local-config-tampering': [],
  'offline-sync-queue': [],
  'report-publish-replacement': [],
  'reservation-validation': [],
  'legacy-date-format': [],
  'archive-test-coverage': [],
  'quoted-csv-fields': [],
  'inventory-retry-idempotency': [],
  'existing-invoice-format': [],
  'conflicting-calendar-visibility': [],
  'unchanged-adjudication': [],
};
const patrolTellCases = new Set([
  'local-config-tampering', 'offline-sync-queue', 'report-publish-replacement',
]);
const patrolRequiredCases = new Set([
  'reservation-validation', 'legacy-date-format', 'archive-test-coverage', 'quoted-csv-fields',
  'inventory-retry-idempotency',
  'existing-invoice-format', 'mail-dispatch-state',
]);
const patrolNoTellCases = new Set(['unchanged-adjudication']);
const patrolQuestionCases = new Set(['conflicting-calendar-visibility']);
const suite = parse(readFileSync(new URL('../scenarios/manager-work-split/manager-work-split.yaml', import.meta.url), 'utf8'));
function assertSemanticGrader(caseId, lang) {
  const row = suite.tests.find(({ vars }) => vars.case === caseId && vars.lang === lang);
  assert.ok(row.assert.some(({ type }) => type === 'llm-rubric'));
}

function scopeQuestion(fixture, lang) {
  return { tool: 'takt_ask_goal_question', arguments: {
    cwd: fixture.cwd, goalId: fixture.goal.id,
    body: lang === 'ja'
      ? '独自の予約形式を作業範囲に含めますか？ 回答まで個別停止した作業は再開しません。'
      : 'Should a custom booking format be included in scope? The individually stopped work will wait for your answer.',
    options: lang === 'ja'
      ? ['既存の予約形式を使い、時間帯だけを検証する', '独自の予約形式も追加する']
      : ['Use the existing booking format and validate time ranges only', 'Also add a custom booking format'],
    recommendation: lang === 'ja'
      ? '既存の予約形式を推奨します。受け入れ条件は時間帯の検証だけを求めているためです。'
      : 'Use the existing booking format because the acceptance criterion only requires time-range validation.',
  } };
}
function enqueue(fixture, key) {
  return { tool: 'takt_enqueue_goal_task', arguments: {
    cwd: fixture.cwd, goalId: fixture.goal.id, workKey: key, purpose: `Implement ${key}`,
    task: `On the current tip of ${fixture.goal.branch}, run npm run build and targeted tests for ${key}; report evidence.`, workflow: 'default',
  } };
}
function tellRun(fixture, content = 'Keep the required behavior and correct the repair scope.') {
  const task = fixture.tasks.find(({ status }) => status === 'running');
  return { tool: 'takt_tell_run', arguments: {
    cwd: fixture.cwd, goalId: fixture.goal.id, taskName: task.name, content,
  } };
}
function goodOutput(caseId, lang) {
  const fixture = loadManagerCase(caseId, lang);
  const conversation = fixture.turn === 'conversation';
  const output = { response: { message: '判断を記録します', summary: conversation
    ? { objective: 'Delivery destinations', outOfScope: [], acceptanceCriteria: ['Existing behavior retained'], constraints: [] } : null },
  calls: selectedKeys[caseId].map((key) => enqueue(fixture, key)) };
  if (caseId === 'escalate-repeated-failure') output.calls.unshift({ tool: 'takt_notify_goal', arguments: {
    cwd: fixture.cwd, goalId: fixture.goal.id, kind: 'blocked',
    body: lang === 'ja'
      ? '検証用の鍵がなく、方針を変えても結合テストが2回失敗しました。設定の読み込み順と接続先を確認し、対象を絞ってやり直しました。管理者が検証用の鍵を発行し、実行環境に設定してください。'
      : 'The test key is missing and integration tests failed twice despite a revised approach. Verified configuration loading order and endpoint and retried a targeted test. The administrator must issue the test key and configure it in the execution environment.',
  } });
  if (caseId === 'escalate-repeated-failure') {
    const independent = output.calls.find(({ tool }) => tool === 'takt_enqueue_goal_task');
    independent.arguments.purpose = fixture.readResults[0].result.work[2].purpose;
    independent.arguments.task = lang === 'ja'
      ? 'src/admin/help.ts の案内文を分かりやすくする。決済や注文保存の実装・確認、購入手順の更新は含めず、案内文だけを確認する。'
      : 'Clarify help text in src/admin/help.ts and check that text only. Exclude payment or order-storage implementation and checks and checkout-guide updates.';
  }
  if (caseId === 'escalate-not-on-first-failure') {
    const task = lang === 'ja'
      ? 'docs/sales-csv.md と data/sales_sample.csv を読んでから sales/loader.py を実装する。sale_date、amount、channel と既存の日付形式を使い、見本データで読み込みと入力検証を確認する。'
      : 'Read docs/sales-csv.md and data/sales_sample.csv before implementing sales/loader.py. Use sale_date, amount, channel and the existing date format; verify loading and validation with the sample data.';
    output.calls = [{ tool: 'takt_retry_goal_task', arguments: {
      cwd: fixture.cwd, goalId: fixture.goal.id, taskName: 'csv-import', task,
    } }];
  }
  if (caseId === 'integration-check') {
    output.calls.push({ tool: 'takt_record_goal_work_log', arguments: {
      cwd: fixture.cwd, goalId: fixture.goal.id,
      summary: 'Prepare dependencies in a temporary worktree at the combined goal tip; build and test saved progress through restart and list display. Record results before completion.',
    } });
  }
  if (patrolTellCases.has(caseId)) {
    output.calls.push(tellRun(fixture));
    output.calls.push({ tool: 'takt_record_goal_work_log', arguments: {
      cwd: fixture.cwd, goalId: fixture.goal.id, summary: 'Recorded the repair item and the source supporting the instruction.',
    } });
  }
  if (caseId === 'existing-invoice-format') {
    output.calls.push({ tool: 'takt_record_goal_work_log', arguments: {
      cwd: fixture.cwd, goalId: fixture.goal.id,
      summary: lang === 'ja'
        ? 'INV-1 は残す。目的が参照する exportAccountInvoices の入力契約は json を許可しているが、invoice-export は csv に制限しており、目的を満たしていない。'
        : 'Retain INV-1. The exportAccountInvoices input contract referenced by the objective permits json, but invoice-export restricts it to csv and fails to fulfill the objective.',
    } });
  }
  if (patrolQuestionCases.has(caseId)) {
    output.calls.push({ tool: 'takt_ask_goal_question', arguments: {
      cwd: fixture.cwd,
      goalId: fixture.goal.id,
      body: 'The two acceptance criteria conflict under the external service constraint. Which behavior should take priority?',
      options: ['Wait for external confirmation before showing the item.', 'Show the item locally while marking it unconfirmed.'],
      recommendation: 'Wait for external confirmation because it avoids presenting unverified bookings as available.',
    } });
  }
  if (caseId === 'constraint-carryover-data') {
    output.calls[0].arguments.purpose = fixture.readResults[0].result.work[0].purpose;
    output.calls[0].arguments.task = [
      output.calls[0].arguments.purpose,
      ...fixture.goal.constraints,
      lang === 'ja'
        ? 'report-export の実装はこの集計の取り込み後の作業へ回す。この作業は全データの再集計を担当しない。全データの再集計は全成果の取り込み後に始める最後の確認作業が 1 回だけ担当する。'
        : 'Defer report-export implementation until this aggregate is integrated. This task does not own full-data recomputation. A final check task started after all results are integrated owns that recomputation exactly once.',
    ].join('\n');
  }
  if (caseId === 'summary-keeps-constraint-web') {
    output.response.summary = lang === 'ja' ? {
      objective: 'オンラインストアの購入画面を整える',
      outOfScope: ['会員認証、配送業者との連携、決済事業者とストア全体のデザインの変更'],
      constraints: [
        '作業の制約: 途中は変更した画面のコンポーネントテストだけを流す。',
        '作業の制約: ブラウザを使う E2E はテスト環境でゴール全体の最後に 1 回だけ流す。',
        '作業の制約: 本番の決済 API は呼ばない。決済はスタブまたはテスト用 API で検証する。',
      ],
      acceptanceCriteria: [
        '数量変更、小計・送料・合計の表示、クーポン入力とエラー、配送先の必須検証、注文確認の入力と金額表示が動く。',
        '決済の成功・失敗が表示され、二重注文を防ぎ、完了画面で注文番号と購入内容を示す。購入手順とエラー案内を更新する。',
        '税込価格の丸め方、会員・ゲストの購入経路を維持し、戻った際の配送先入力を失わない。コンポーネントテストと E2E が通る。',
      ],
    } : {
      objective: 'Improve online store checkout screens',
      outOfScope: ['Changes to member authentication, shipping carrier integration, payment provider or whole-store design'],
      constraints: [
        'Work constraint: During work, run only component tests for changed screens.',
        'Work constraint: Run browser E2E in the test environment exactly once at the end of the whole goal.',
        'Work constraint: Never call the production payment API. Validate payments with a stub or the test API.',
      ],
      acceptanceCriteria: [
        'Support quantity changes, subtotal/shipping/total display, coupon input and errors, required address validation and order review of details and prices.',
        'Show payment success/failure, prevent duplicate orders and show the order number and purchased items on completion. Update checkout and error guidance.',
        'Preserve tax-inclusive rounding and member/guest paths, retain address input when going back and pass component tests and E2E.',
      ],
    };
  }
  if (caseId.startsWith('no-check-') || caseId === 'integration-already-checked') output.calls.push({ tool: 'takt_complete_goal', arguments: {
    cwd: fixture.cwd, goalId: fixture.goal.id, expectedSha: 'c'.repeat(40), summary: 'Acceptance criteria verified in run reports.',
  } });
  return output;
}
const score = (output, caseId, lang = 'ja') => evaluate(typeof output === 'string' ? output : JSON.stringify(output), { vars: { case: caseId, lang } });
function verificationOutput(fixture, summary) {
  return {
    response: { message: fixture.lang === 'ja' ? '確認方法を記録します。' : 'Recording the verification decision.', summary: null },
    calls: [{ tool: 'takt_record_goal_work_log', arguments: { cwd: fixture.cwd, goalId: fixture.goal.id, summary } }],
  };
}
function writingCalls(fixture, _keys) {
  const base = { cwd: fixture.cwd, goalId: fixture.goal.id };
  const task = fixture.tasks.find(({ status }) => status === 'running') ?? fixture.tasks[0];
  const completedTask = fixture.tasks.find(({ status }) => status === 'completed') ?? task;
  return {
    takt_enqueue_goal_task: enqueue(fixture, 'unexpected-work').arguments,
    takt_requeue_goal_task: { ...base, taskName: task.name },
    takt_retry_goal_task: { ...base, taskName: task.name, task: 'Corrected instructions.' },
    takt_remove_goal_task: { ...base, taskName: task.name, reason: 'No longer needed.' },
    takt_merge_goal_task: { ...base, taskName: completedTask.name, expectedSha: 'c'.repeat(40) },
    takt_complete_goal: { ...base, expectedSha: 'c'.repeat(40), summary: 'Reviewed acceptance evidence.' },
    takt_check_goal_completion: base,
    takt_ask_goal_question: { ...base, body: 'Approve these work units?' },
    takt_tell_run: { ...base, taskName: task.name, content: 'Review the repair target.' },
    takt_withdraw_goal_question: { ...base, questionId: '650e8400-e29b-41d4-a716-446655440001' },
    takt_notify_goal: { ...base, kind: 'custom', body: 'Decision recorded.' },
    takt_record_goal_work_log: {
      cwd: fixture.cwd, goalId: fixture.goal.id, summary: 'Reviewed the available evidence and selected the next work.',
    },
  };
}
for (const lang of ['ja', 'en']) {
  for (const caseId of ['parallel-cli', 'parallel-docs-migration']) {
    test(`${lang}/${caseId}: rejects withholding any ready independent task below the available limit`, () => {
      const correct = goodOutput(caseId, lang);
      assertSemanticGrader(caseId, lang);
      for (let index = 0; index < correct.calls.length; index++) {
        const output = structuredClone(correct);
        output.calls.splice(index, 1);
        assert.equal(score(output, caseId, lang).pass, false);
      }
    });
  }

  test(`${lang}: data carryover submits only the next aggregate task before CSV export and final recomputation`, () => {
    const fixture = loadManagerCase('constraint-carryover-data', lang);
    for (const key of ['report-export', 'recompute-all-data']) {
      const output = goodOutput('constraint-carryover-data', lang);
      output.calls = [enqueue(fixture, key)];
      assert.equal(score(output, 'constraint-carryover-data', lang).pass, false);
      output.calls.unshift(enqueue(fixture, 'channel-totals'));
      assert.equal(score(output, 'constraint-carryover-data', lang).pass, false);
    }
    const output = goodOutput('constraint-carryover-data', lang);
    output.calls.push({ tool: 'takt_complete_goal', arguments: {
      cwd: fixture.cwd, goalId: fixture.goal.id, expectedSha: 'c'.repeat(40), summary: 'Done',
    } });
    assert.equal(score(output, 'constraint-carryover-data', lang).pass, false);
  });

  test(`${lang}: data and web constraint meanings are delegated to their semantic graders`, () => {
    const output = goodOutput('constraint-carryover-data', lang);
    const bodies = lang === 'ja' ? [
      output.calls[0].arguments.task,
      '月別・販売経路別の集計を追加する。',
      '変更したモジュールの pytest を流し、この作業の最後に全データで再集計する。本番 DB に接続して検証する。',
      'すべての pytest と全データでの再集計を恒久的に禁止する。',
    ] : [
      output.calls[0].arguments.task,
      'Add monthly sales aggregates by channel.',
      'Run pytest for changed modules and recompute all data at the end of this task. Connect to the production DB to validate.',
      'Permanently prohibit all pytest tests and full-data recomputation.',
    ];
    for (const body of bodies) {
      output.calls[0].arguments.task = body;
      assert.equal(score(output, 'constraint-carryover-data', lang).pass, true);
    }
    assertSemanticGrader('constraint-carryover-data', lang);
    const summary = goodOutput('summary-keeps-constraint-web', lang);
    assert.equal(score(summary, 'summary-keeps-constraint-web', lang).pass, true);
    summary.response.summary.constraints = lang === 'ja'
      ? ['作業の制約: 各画面の作業の最後に E2E を流す。本番の決済 API で検証する。']
      : ['Work constraint: Run E2E at the end of each screen task. Validate with the production payment API.'];
    assert.equal(score(summary, 'summary-keeps-constraint-web', lang).pass, true);
    assertSemanticGrader('summary-keeps-constraint-web', lang);
  });

  for (const caseId of Object.keys(selectedKeys)) {
    test(`${lang}/${caseId}: accepts intended tool calls and rejects missing required response or calls`, () => {
      const correct = goodOutput(caseId, lang);
      assert.equal(score(correct, caseId, lang).pass, true);
      const wrong = structuredClone(correct);
      if (caseId.startsWith('summary-')) wrong.response.summary = null;
      else if (patrolNoTellCases.has(caseId) || patrolRequiredCases.has(caseId) || caseId === 'integration-check') wrong.response.summary = { objective: 'Invalid event summary' };
      else wrong.calls = [];
      assert.equal(score(wrong, caseId, lang).pass, false);
    });
    test(`${lang}/${caseId}: rejects writes outside the case's permitted actions`, () => {
      const fixture = loadManagerCase(caseId.startsWith('summary-') ? 'parallel-cli' : caseId, lang);
      const calls = writingCalls(fixture, selectedKeys[caseId]);
      const allowed = caseId === 'escalate-repeated-failure'
        ? ['takt_enqueue_goal_task', 'takt_notify_goal', 'takt_ask_goal_question', 'takt_record_goal_work_log']
        : caseId === 'escalate-not-on-first-failure'
          ? ['takt_requeue_goal_task', 'takt_retry_goal_task', 'takt_record_goal_work_log', 'takt_notify_goal']
        : patrolTellCases.has(caseId) ? ['takt_tell_run', 'takt_record_goal_work_log', 'takt_notify_goal']
          : patrolQuestionCases.has(caseId) ? ['takt_ask_goal_question', 'takt_tell_run', 'takt_record_goal_work_log', 'takt_notify_goal']
            : patrolRequiredCases.has(caseId) ? ['takt_tell_run', 'takt_ask_goal_question', 'takt_record_goal_work_log', 'takt_notify_goal']
            : patrolNoTellCases.has(caseId) ? ['takt_record_goal_work_log', 'takt_notify_goal']
              : caseId.startsWith('summary-') ? [] : caseId === 'integration-check'
                ? ['takt_record_goal_work_log', 'takt_notify_goal'] : [
        'takt_merge_goal_task', 'takt_record_goal_work_log', 'takt_notify_goal',
        caseId.startsWith('no-check-') || caseId === 'integration-already-checked' ? 'takt_complete_goal' : 'takt_enqueue_goal_task',
      ];
      for (const [tool, args] of Object.entries(calls)) {
        assert.ok(managerWriteSchemas[tool].safeParse(args).success, tool);
        if (allowed.includes(tool)) continue;
        for (const position of ['before', 'after']) {
          const output = goodOutput(caseId, lang);
          const call = { tool, arguments: args };
          if (position === 'before') output.calls.unshift(call);
          else output.calls.push(call);
          const graded = score(output, caseId, lang);
          assert.equal(graded.pass, false, `${tool} ${position}`);
          if (!caseId.startsWith('summary-')) assert.equal(graded.reason, `Writing tool not allowed for this case: ${tool}`);
        }
      }
    });
    if (!caseId.startsWith('summary-')) {
      test(`${lang}/${caseId}: permits work log entries and notifications`, () => {
        const fixture = loadManagerCase(caseId, lang);
        const calls = writingCalls(fixture, selectedKeys[caseId]);
        const output = goodOutput(caseId, lang);
        output.calls.unshift({ tool: 'takt_record_goal_work_log', arguments: calls.takt_record_goal_work_log });
        output.calls.push({ tool: 'takt_notify_goal', arguments: calls.takt_notify_goal });
        assert.equal(score(output, caseId, lang).pass, true);
      });
    }
  }
}
for (const lang of ['ja', 'en']) {
  test(`${lang}: existing invoice format uses structural checks and delegates dismissal meaning to the rubric`, () => {
    const caseId = 'existing-invoice-format';
    const fixture = loadManagerCase(caseId, lang);
    const retained = goodOutput(caseId, lang);
    retained.response.message = lang === 'ja'
      ? '既存の JSON 出力を使うことは目的に含まれるため、指摘を残します。'
      : 'Retain the finding: using the existing JSON exporter is part of the objective.';
    assert.equal(score(retained, caseId, lang).pass, true);
    assertSemanticGrader(caseId, lang);
    for (const content of [
      'Accept the existing JSON format as required by the objective.',
      'Drop the JSON finding as outside the requested scope.',
      'Purpose and exclusions conflict; retain the finding pending the human answer.',
    ]) {
      const output = structuredClone(retained);
      output.calls.push(tellRun(fixture, content));
      // The rubric must judge meaning even when all production arguments are valid.
      assert.equal(score(output, caseId, lang).pass, true);
    }
    const output = structuredClone(retained);
    output.calls.push(tellRun(fixture));
    for (const [key, value] of [
      ['cwd', '/workspace/other'], ['goalId', '650e8400-e29b-41d4-a716-446655440001'],
      ['taskName', 'another-task'], ['content', 42],
    ]) {
      const invalid = structuredClone(output);
      invalid.calls.find(({ tool }) => tool === 'takt_tell_run').arguments[key] = value;
      assert.equal(score(invalid, caseId, lang).pass, false);
    }
    const secondGoal = fixture.additionalGoals[0];
    const withPatrolLog = structuredClone(retained);
    withPatrolLog.calls.push({ tool: 'takt_record_goal_work_log', arguments: {
      cwd: fixture.cwd, goalId: secondGoal.id, kind: 'patrol', summary: 'invoice-search implementation has no new issue.',
    } });
    assert.equal(score(withPatrolLog, caseId, lang).pass, true);
    withPatrolLog.calls[1].arguments.goalId = '650e8400-e29b-41d4-a716-446655440099';
    assert.equal(score(withPatrolLog, caseId, lang).pass, false);
    const wrongTask = structuredClone(output);
    wrongTask.calls.find(({ tool }) => tool === 'takt_tell_run').arguments.taskName = fixture.tasks[1].name;
    assert.equal(score(wrongTask, caseId, lang).pass, false);
  });

  test(`${lang}: existing invoice format requires the finding decision log under invoice-export`, () => {
    const caseId = 'existing-invoice-format';
    const fixture = loadManagerCase(caseId, lang);
    const output = goodOutput(caseId, lang);
    assert.equal(score(output, caseId, lang).pass, true);
    assert.equal(score({ ...output, calls: [] }, caseId, lang).pass, false);

    const wrongGoal = structuredClone(output);
    wrongGoal.calls[0].arguments.goalId = fixture.additionalGoals[0].id;
    assert.equal(score(wrongGoal, caseId, lang).pass, false);
    wrongGoal.calls.push(tellRun(fixture));
    assert.equal(score(wrongGoal, caseId, lang).pass, false);

    const bothGoals = structuredClone(output);
    bothGoals.calls.push(...wrongGoal.calls);
    assert.equal(score(bothGoals, caseId, lang).pass, true);
  });

  test(`${lang}: sends one instruction only for unsupported or unnecessarily complex repair items`, () => {
    for (const caseId of patrolTellCases) {
      const output = goodOutput(caseId, lang);
      assertSemanticGrader(caseId, lang);
      assert.equal(score(output, caseId, lang).pass, true);
      assert.equal(output.calls.filter(({ tool }) => tool === 'takt_tell_run').length, 1);
      const duplicate = structuredClone(output);
      duplicate.calls.push(structuredClone(duplicate.calls.find(({ tool }) => tool === 'takt_tell_run')));
      assert.equal(score(duplicate, caseId, lang).pass, false);
      const withoutTell = structuredClone(output);
      withoutTell.calls = withoutTell.calls.filter(({ tool }) => tool !== 'takt_tell_run');
      assert.equal(score(withoutTell, caseId, lang).pass, false);
      const wrongTask = structuredClone(output);
      wrongTask.calls.find(({ tool }) => tool === 'takt_tell_run').arguments.taskName = 'another-task';
      assert.equal(score(wrongTask, caseId, lang).pass, false);
    }
  });

  test(`${lang}: permits instructions and questions for required items subject to semantic grading`, () => {
    for (const caseId of patrolRequiredCases) {
      const fixture = loadManagerCase(caseId, lang);
      const output = goodOutput(caseId, lang);
      assertSemanticGrader(caseId, lang);
      assert.equal(score(output, caseId, lang).pass, true);
      output.calls.push(tellRun(fixture));
      output.calls.push({ tool: 'takt_ask_goal_question', arguments: {
        cwd: fixture.cwd, goalId: fixture.goal.id, body: 'Please clarify the basis for the required behavior.',
      } });
      assert.equal(score(output, caseId, lang).pass, true);
      const duplicate = structuredClone(output);
      const repeatedTell = structuredClone(duplicate.calls.find(({ tool }) => tool === 'takt_tell_run'));
      repeatedTell.arguments.content = 'Continue the required repair.';
      duplicate.calls.push(repeatedTell);
      assert.deepEqual(score(duplicate, caseId, lang), {
        pass: false, score: 0, reason: 'Do not send repeated instructions to the same task',
      });
      const wrongRecipient = structuredClone(output);
      wrongRecipient.calls.find(({ tool }) => tool === 'takt_ask_goal_question').arguments.recipient = 'director';
      assert.deepEqual(score(wrongRecipient, caseId, lang), {
        pass: false, score: 0, reason: 'Invalid production arguments: takt_ask_goal_question',
      });
      const wrongTask = structuredClone(output);
      wrongTask.calls.find(({ tool }) => tool === 'takt_tell_run').arguments.taskName = 'another-task';
      assert.deepEqual(score(wrongTask, caseId, lang), {
        pass: false, score: 0, reason: 'Choose the running goal task',
      });
    }
  });

  test(`${lang}: does not tell a running task to drop a required behavior, test or unchanged adjudication`, () => {
    for (const caseId of patrolNoTellCases) {
      const output = goodOutput(caseId, lang);
      assert.equal(score(output, caseId, lang).pass, true);
      assert.equal(output.calls.filter(({ tool }) => tool === 'takt_tell_run').length, 0);
      output.calls.push(tellRun(loadManagerCase(caseId, lang)));
      assert.equal(score(output, caseId, lang).pass, false);
    }
  });

  test(`${lang}: asks a human about conflicting criteria and permits a run instruction subject to semantic grading`, () => {
    const caseId = 'conflicting-calendar-visibility';
    const output = goodOutput(caseId, lang);
    assertSemanticGrader(caseId, lang);
    assert.equal(score(output, caseId, lang).pass, true);
    const instruction = lang === 'ja'
      ? '人の回答までこの方針に依存する結論を出さず、受け入れ条件は変えない。依存しない作業は続けてよい。'
      : 'Do not decide matters dependent on this choice until the person answers; keep both criteria and continue independent work.';
    output.calls.push(tellRun(loadManagerCase(caseId, lang), instruction));
    assert.equal(score(output, caseId, lang).pass, true);
    const duplicate = structuredClone(output);
    duplicate.calls.push(structuredClone(duplicate.calls[1]));
    assert.equal(score(duplicate, caseId, lang).pass, false);
    const wrongTask = structuredClone(output);
    wrongTask.calls[1].arguments.taskName = 'another-task';
    assert.equal(score(wrongTask, caseId, lang).pass, false);
    output.calls = output.calls.filter(({ tool }) => tool !== 'takt_ask_goal_question');
    assert.equal(score(output, caseId, lang).pass, false);
  });
}
test('accepts a complete JSON code fence while preserving production envelope validation', () => {
  const output = JSON.stringify(goodOutput('parallel-cli', 'ja'), null, 2);
  for (const fence of ['json', 'JSON', '']) {
    assert.equal(score(` \n\`\`\`${fence}\n${output}\n\`\`\`\n`, 'parallel-cli').pass, true);
  }
  assert.equal(score(`\`\`\`json\r\n${output}\r\n\`\`\``, 'parallel-cli').pass, true);
});
for (const lang of ['ja', 'en']) {
  test(`${lang}: reads a top-level summary using the same response summary validation`, () => {
    for (const caseId of ['parallel-cli', 'summary-keeps-constraint']) {
      const output = goodOutput(caseId, lang);
      output.summary = output.response.summary;
      delete output.response.summary;
      assert.equal(score(output, caseId, lang).pass, true);
      assert.equal(score(`\`\`\`json\n${JSON.stringify(output)}\n\`\`\``, caseId, lang).pass, true);
      output.summary = { objective: 'Incomplete summary' };
      assert.equal(score(output, caseId, lang).pass, false);
    }
    const output = goodOutput('parallel-cli', lang);
    output.summary = goodOutput('summary-keeps-constraint', lang).response.summary;
    delete output.response.summary;
    assert.equal(score(output, 'parallel-cli', lang).pass, false);
  });

  test(`${lang}: treats an omitted event summary as null without allowing an omitted conversation summary`, () => {
    for (const caseId of Object.keys(selectedKeys)) {
      const output = goodOutput(caseId, lang);
      delete output.response.summary;
      assert.equal(score(output, caseId, lang).pass, !caseId.startsWith('summary-'));
    }
    const output = goodOutput('parallel-cli', lang);
    delete output.response.summary;
    delete output.calls[0].arguments.workflow;
    assert.equal(score(output, 'parallel-cli', lang).pass, false);
  });
}
test('rejects trailing content and additional envelopes, including prohibited calls', () => {
  const caseId = 'reservation-validation';
  const output = goodOutput(caseId, 'ja');
  const forbidden = structuredClone(output);
  forbidden.calls.push(tellRun(loadManagerCase(caseId, 'ja')));
  const json = JSON.stringify(output);
  const suffixes = ['\n{}', '\nAdditional explanation', `\n${JSON.stringify(forbidden)}`, '\n```json\n{}\n```'];
  for (const suffix of suffixes) {
    assert.equal(score(`${json}${suffix}`, caseId).pass, false);
    assert.equal(score(`\`\`\`json\n${json}${suffix}\n\`\`\``, caseId).pass, false);
    assert.equal(score(`\`\`\`json\n${json}\n\`\`\`${suffix}`, caseId).pass, false);
  }
});
test('rejects malformed JSON and malformed production response/call envelopes inside or outside fences', () => {
  for (const output of [
    'not json', '```json\n{}\n```', '{}', '{"response":{"message":"x","summary":null},"calls":{}}',
    '{"response":{"message":"x"}}', '{"calls":[]}', '{"response":null,"calls":[]}',
    '{"response":[],"calls":[]}', '{"response":"x","calls":[]}',
    '{"response":{"message":"x","summary":null},"summary":null,"calls":[]}',
    '{"response":{"message":"x"},"calls":[],}',
  ]) {
    assert.equal(score(output, 'parallel-cli').pass, false);
  }
  const output = goodOutput('parallel-cli', 'ja');
  output.response.calls = [];
  assert.equal(score(output, 'parallel-cli').pass, false);
  assert.equal(score(`\`\`\`json\n${JSON.stringify(output)}\n\`\`\``, 'parallel-cli').pass, false);
  for (const text of [
    `Explanation\n\`\`\`json\n${JSON.stringify(goodOutput('parallel-cli', 'ja'))}\n\`\`\``,
    `\`\`\`json\n${JSON.stringify(goodOutput('parallel-cli', 'ja'))}`,
    `${JSON.stringify(goodOutput('parallel-cli', 'ja'))}}`,
    `${JSON.stringify(goodOutput('parallel-cli', 'ja')).slice(0, -1)}`,
    `{invalid}\n${JSON.stringify(goodOutput('parallel-cli', 'ja'))}`,
  ]) assert.equal(score(text, 'parallel-cli').pass, false);
});
test('rejects early consumers, duplicate work and unnecessary serialization', () => {
  const output = goodOutput('parallel-cli', 'ja');
  output.calls.push(enqueue(loadManagerCase('parallel-cli', 'ja'), 'aggregate-command'));
  assert.equal(score(output, 'parallel-cli').pass, false);
  output.calls = output.calls.slice(0, 1);
  assert.equal(score(output, 'parallel-cli').pass, false);
  output.calls.push({ ...output.calls[0], arguments: { ...output.calls[0].arguments } });
  assert.equal(score(output, 'parallel-cli').pass, false);
});
for (const lang of ['ja', 'en']) {
  test(`${lang}: rejects two shared-resource submissions, shared-definition consumers and reversed human order`, () => {
    for (const [caseId, additional] of [['shared-resource', 'worker-permissions'], ['shared-definition', 'assignment-mcp'], ['shared-definition', 'assignment-ui'], ['human-order', 'migration-b']]) {
      const output = goodOutput(caseId, lang);
      output.calls.push(enqueue(loadManagerCase(caseId, lang), additional));
      assert.equal(score(output, caseId, lang).pass, false);
    }
    const output = goodOutput('human-order', lang);
    output.calls = [enqueue(loadManagerCase('human-order', lang), 'migration-b')];
    assert.equal(score(output, 'human-order', lang).pass, false);
  });
}
test('rejects premature completion and check-only tasks', () => {
  const output = goodOutput('integration-check', 'ja');
  output.calls.push(goodOutput('no-check-docs', 'ja').calls[0]);
  assert.equal(score(output, 'integration-check').pass, false);
  output.calls.pop();
  output.calls = [enqueue(loadManagerCase('integration-check', 'ja'), 'check-a'), enqueue(loadManagerCase('integration-check', 'ja'), 'check-b')];
  assert.equal(score(output, 'integration-check').pass, false);
});

for (const lang of ['ja', 'en']) {
  test(`${lang}: final-check plans and work logs are optional when test selection is not being assessed`, () => {
    for (const caseId of ['integration-check', 'plan-cancelled', 'plan-integrated']) {
      const fixture = loadManagerCase(caseId, lang);
      const output = { response: { message: 'Final checks remain unverified.', summary: null }, calls: [] };
      assert.equal(score(output, caseId, lang).pass, true, caseId);
      output.calls.push({ tool: 'takt_record_goal_work_log', arguments: {
        cwd: fixture.cwd, goalId: fixture.goal.id, summary: 'Required work is integrated.',
      } });
      assert.equal(score(output, caseId, lang).pass, true, caseId);
      output.calls.push(enqueue(fixture, 'usage-docs'));
      assert.equal(score(output, caseId, lang).pass, false, caseId);
    }
  });

  test(`${lang}: accepts ordered work bodies including equivalent wording and explicit deferrals`, () => {
    const bodies = lang === 'ja' ? [
      ['shared-resource', 'web-permissions', 'web 用の実行ロールに読み取り権限を追加する。'],
      ['shared-resource', 'worker-permissions', 'worker 用の実行ロールに書き込み権限を追加する。web の変更はこの成果を取り込んでから別の作業で行う。'],
      ['shared-definition', 'resolve-assignment', '保存済みの割り当てを起動時に解決し、共通の定義を作る。MCP ツールと画面表示の実装は、この成果の取り込み後の作業へ回す。'],
      ['human-order', 'migration-a', 'A 環境の台帳を既存の新形式へ変換し、結果を報告する。B の移行は A の結果を確認してから別の作業で行う。'],
    ] : [
      ['shared-resource', 'web-permissions', 'Add read access to the web runtime role.'],
      ['shared-resource', 'worker-permissions', 'Add write access to the worker runtime role. Defer web changes to another task after this result is integrated.'],
      ['shared-definition', 'resolve-assignment', 'Resolve stored assignments on startup and define their shared contract. Defer implementation of MCP tools and UI display to later tasks after integration.'],
      ['human-order', 'migration-a', 'Convert the environment A ledger to the existing new format and report results. Leave migration B to a later task after the result of A has been reviewed.'],
    ];
    for (const [caseId, key, body] of bodies) {
      const output = goodOutput(caseId, lang);
      output.calls = [enqueue(loadManagerCase(caseId, lang), key)];
      output.calls[0].arguments.purpose = body;
      output.calls[0].arguments.task = body;
      assert.equal(score(output, caseId, lang).pass, true);
      assertSemanticGrader(caseId, lang);
    }
  });

  test(`${lang}: delegates final-check plan meaning to the rubric`, () => {
    const output = goodOutput('integration-check', lang);
    const tasks = lang === 'ja' ? [
      'takt/goal/catalog の最新版で npm run build と npm test を実行し、保存形式から読み取りまで受け入れ条件を確認する。失敗があれば直す。',
      '両方の成果を取り込んだこのゴールのブランチでコンパイルと自動検証を行い、不具合を修正して証跡を報告する。',
      '両方の成果を取り込んだゴール用ブランチの今の先端でビルドと保存形式から読み取りまでのテストを実行する。失敗は証跡とともに報告し、manager が後で修正作業を投入する。',
      '現在の takt/goal/catalog ではビルドとテストを実行しない。README を更新する。',
    ] : [
      'On the latest takt/goal/catalog run npm run build and npm test against the saved-state reader acceptance path; repair failures.',
      'Compile and exercise the acceptance path on this goal branch with both results integrated; repair any failures and report evidence.',
      'Run build and saved-state reader tests on the current goal-branch tip after both results are integrated. Report failures and evidence so the manager can submit follow-up repair work.',
      'Do not run build or tests on the current takt/goal/catalog tip. Update the README.',
    ];
    for (const task of tasks) {
      output.calls[0].arguments.summary = task;
      assert.equal(score(output, 'integration-check', lang).pass, true);
    }
    assertSemanticGrader('integration-check', lang);
  });

  test(`${lang}: delegates correctly keyed but wrong purpose/task bodies to semantic graders`, () => {
    for (const [caseId, wrongBody] of [
      ['parallel-cli', 'Implement aggregate using all three unfinished command output formats.'],
      ['parallel-docs-migration', 'Implement aggregate using unfinished search and export outputs.'],
      ['constraint-once', 'Implement both ping logging and users paging in this work unit.'],
      ['shared-resource', lang === 'ja' ? '権限設定ではなく案内文を更新する。' : 'Update help text instead of permissions.'],
      ['shared-definition', lang === 'ja' ? '起動時の定義と MCP ツール、画面表示をこの作業で実装する。' : 'Implement the startup definition, MCP tools and UI display in this task.'],
      ['human-order', lang === 'ja' ? 'A と B の移行を同時に実行する。' : 'Run migrations A and B simultaneously.'],
    ]) {
      for (const field of ['purpose', 'task']) {
        const output = goodOutput(caseId, lang);
        output.calls.forEach((call) => { call.arguments[field] = wrongBody; });
        assert.equal(score(output, caseId, lang).pass, true);
        assertSemanticGrader(caseId, lang);
      }
    }
  });
}
test('rejects extra check tasks for unrelated results and stale completion SHAs', () => {
  for (const caseId of ['no-check-docs', 'no-check-same-module', 'integration-already-checked']) {
    const output = goodOutput(caseId, 'ja');
    output.calls[0].arguments.expectedSha = 'b'.repeat(40);
    assert.equal(score(output, caseId).pass, false);
    output.calls[0].arguments.expectedSha = 'c'.repeat(40);
    output.calls.unshift(enqueue(loadManagerCase(caseId, 'ja'), 'check-results'));
    assert.equal(score(output, caseId).pass, false);
  }
});
test('validates production tool names, arguments, goal identity, workflow and required fields', () => {
  for (const mutate of [
    (call) => { call.tool = 'takt_enqueue_task'; },
    (call) => { call.tool = 'toString'; },
    (call) => { call.arguments.task = ''; },
    (call) => { call.arguments.instruction = call.arguments.task; delete call.arguments.task; },
    (call) => { call.arguments.taskName = 'invented'; },
    (call) => { call.arguments.cwd = '/another/project'; },
    (call) => { call.arguments.goalId = '650e8400-e29b-41d4-a716-446655440099'; },
    (call) => { call.arguments.workflow = 'invented'; },
    (call) => { delete call.arguments.workflow; },
    (call) => { call.arguments.workflow = ''; },
    (call) => { call.arguments.workflow = ' '; },
  ]) {
    const output = goodOutput('parallel-cli', 'ja');
    mutate(output.calls[0]);
    assert.equal(score(output, 'parallel-cli').pass, false);
  }
});
test('rejects integration of an already integrated result, even with the matching task and SHA', () => {
  const fixture = loadManagerCase('parallel-cli', 'ja');
  const task = fixture.tasks[0];
  const retry = { tool: 'takt_merge_goal_task', arguments: {
    cwd: fixture.cwd, goalId: fixture.goal.id, taskName: task.name, expectedSha: task.completion.sha,
  } };
  const output = goodOutput('parallel-cli', 'ja');
  output.calls.unshift(structuredClone(retry));
  assert.equal(score(output, 'parallel-cli').pass, false);
  output.calls[0].arguments.taskName = 'unknown-task';
  assert.equal(score(output, 'parallel-cli').pass, false);
  output.calls[0] = structuredClone(retry);
  output.calls[0].arguments.expectedSha = 'b'.repeat(40);
  assert.equal(score(output, 'parallel-cli').pass, false);
  output.calls[0] = structuredClone(retry);
  output.calls.push(output.calls.shift());
  assert.equal(score(output, 'parallel-cli').pass, false);
});

for (const lang of ['ja', 'en']) {
  test(`${lang}: rejects repeated integration after integration-check results are already saved`, () => {
    const fixture = loadManagerCase('integration-check', lang);
    const task = fixture.tasks[0];
    const output = goodOutput('integration-check', lang);
    output.calls.unshift({ tool: 'takt_merge_goal_task', arguments: {
      cwd: fixture.cwd, goalId: fixture.goal.id, taskName: task.name,
      expectedSha: task.completion.sha,
    } });
    assert.equal(score(output, 'integration-check', lang).pass, false);
  });

}
for (const lang of ['ja', 'en']) {
  for (const caseId of ['spec-formal-on-code', 'spec-review-investigation']) {
    test(`${lang}/${caseId}: formal code proposals require all three nonempty specification bodies in summary`, () => {
      assertSemanticGrader(caseId, lang);
      const output = { response: { message: 'Review the proposal.', summary: {
        objective: 'Fix notification retries', outOfScope: [], constraints: [],
        acceptanceCriteria: ['AC-1: Verify the saved specifications.'],
        specifications: { gherkin: 'Feature: Notification retries', quint: 'module retries {}', alloy: 'module retries' },
      } }, calls: [] };
      assert.equal(score(output, caseId, lang).pass, true);
      for (const key of ['gherkin', 'quint', 'alloy']) {
        for (const body of [undefined, '', ' ']) {
          const invalid = structuredClone(output);
          invalid.response.summary.specifications[key] = body;
          assert.equal(score(invalid, caseId, lang).pass, false, `${key}: ${JSON.stringify(body)}`);
        }
      }
      const messageOnly = structuredClone(output);
      messageOnly.response.message = JSON.stringify(messageOnly.response.summary.specifications);
      delete messageOnly.response.summary.specifications;
      assert.equal(score(messageOnly, caseId, lang).pass, false);
      const missingSummary = structuredClone(output);
      missingSummary.response.summary = null;
      assert.equal(score(missingSummary, caseId, lang).pass, false);
    });
  }

  test(`${lang}: formal mode off requires Gherkin and rejects either formal specification key`, () => {
    const caseId = 'spec-formal-off-code';
    assertSemanticGrader(caseId, lang);
    const output = { response: { message: 'Review the proposal.', summary: {
      objective: 'Fix notification retries', outOfScope: [], constraints: [],
      acceptanceCriteria: ['AC-1: Verify the saved specifications.'],
      specifications: { gherkin: 'Feature: Notification retries' },
    } }, calls: [] };
    assert.equal(score(output, caseId, lang).pass, true);
    const missing = structuredClone(output);
    delete missing.response.summary.specifications;
    assert.equal(score(missing, caseId, lang).pass, false);
    for (const key of ['quint', 'alloy']) {
      const invalid = structuredClone(output);
      invalid.response.summary.specifications[key] = 'Formal specification body';
      assert.equal(score(invalid, caseId, lang).pass, false);
    }
  });

  test(`${lang}: documentation proposals use the objective and acceptance criteria and reject Gherkin`, () => {
    const caseId = 'spec-docs-goal';
    assertSemanticGrader(caseId, lang);
    const output = { response: { message: 'Review the proposal.', summary: {
      objective: 'Create a guide navigation document', outOfScope: [], constraints: [],
      acceptanceCriteria: ['AC-1: Include feature references, examined sources and missing explanations.'],
    } }, calls: [] };
    assert.equal(score(output, caseId, lang).pass, true);
    output.response.summary.specifications = {};
    assert.equal(score(output, caseId, lang).pass, true);
    output.response.summary.specifications.gherkin = 'Feature: Guide navigation';
    assert.equal(score(output, caseId, lang).pass, false);
    output.response.summary = null;
    assert.equal(score(output, caseId, lang).pass, false);
  });
}

test('summary turns cannot create a goal or submit work before human approval', () => {
  const output = goodOutput('summary-keeps-constraint', 'ja');
  output.calls.push(enqueue(loadManagerCase('parallel-cli', 'ja'), 'users-command'));
  assert.equal(score(output, 'summary-keeps-constraint').pass, false);
});
test('validates summaries with explicit constraints and optional branches without registration fields', () => {
  const caseId = 'summary-keeps-constraint';
  const output = goodOutput(caseId, 'ja');
  output.response.summary.constraints = ['Run targeted tests during work.'];
  output.response.summary.startBranch = 'main';
  output.response.summary.integrationBranch = 'feat/checkout';
  assert.equal(score(output, caseId).pass, true);
  for (const constraints of [undefined, 'Run targeted tests', ['']]) {
    const invalid = structuredClone(output);
    invalid.response.summary.constraints = constraints;
    assert.equal(score(invalid, caseId).pass, false);
  }
  const invalid = structuredClone(output);
  invalid.response.summary.id = '650e8400-e29b-41d4-a716-446655440000';
  assert.equal(score(invalid, caseId).pass, false);
});
for (const lang of ['ja', 'en']) {
  test(`${lang}: summary cases accept the production repository field and retain strict validation`, () => {
    const specifications = { gherkin: 'Feature: Retry', quint: 'module retry {}', alloy: 'module retry' };
    for (const [caseId, bodies] of [
      ['summary-keeps-constraint', undefined],
      ['spec-formal-on-code', specifications],
      ['spec-review-investigation', specifications],
      ['spec-formal-off-code', { gherkin: specifications.gherkin }],
      ['spec-docs-goal', undefined],
    ]) {
      const output = goodOutput('summary-keeps-constraint', lang);
      output.response.summary.repositoryDirectory = loadManagerCase(caseId, lang).cwd;
      if (bodies !== undefined) output.response.summary.specifications = bodies;
      assert.equal(score(output, caseId, lang).pass, true, caseId);
      for (const [key, value] of [
        ['repositoryDirectory', ''], ['repositoryDirectory', 42],
        ['repositoryDirectory', '/workspace/other'], ['objective', 'unsafe\u001b[31m'],
        ['workflow', 'default'], ['id', '650e8400-e29b-41d4-a716-446655440000'],
      ]) {
        const invalid = structuredClone(output);
        invalid.response.summary[key] = value;
        assert.equal(score(invalid, caseId, lang).pass, false, `${caseId}: ${key}`);
      }
    }
  });
}
test('distinguishes invalid JSON from unsupported fields and invalid specification values', () => {
  const caseId = 'spec-docs-goal';
  const output = goodOutput('summary-keeps-constraint', 'ja');
  for (const malformed of [
    `${JSON.stringify(output)}}`,
    JSON.stringify(output).replace('Delivery destinations', 'Delivery\ndestinations'),
  ]) {
    const graded = score(malformed, caseId);
    assert.equal(graded.pass, false);
    assert.match(graded.reason, /^Invalid JSON:/);
  }
  for (const [key, value] of [['workflow', 'default'], ['specifications', null]]) {
    const invalid = structuredClone(output);
    invalid.response.summary[key] = value;
    const graded = score(invalid, caseId);
    assert.equal(graded.pass, false);
    assert.ok(graded.reason.includes(key));
  }
});
test('validates standalone work log summaries and rejects unrelated fields', () => {
  const fixture = loadManagerCase('parallel-cli', 'ja');
  const output = goodOutput('parallel-cli', 'ja');
  const entry = { tool: 'takt_record_goal_work_log', arguments: writingCalls(fixture, selectedKeys['parallel-cli']).takt_record_goal_work_log };
  output.calls.unshift(entry);
  assert.equal(score(output, 'parallel-cli').pass, true);
  for (const mutate of [
    (args) => { args.summary = ''; },
    (args) => { args.summary = ' '; },
    (args) => { delete args.summary; },
    (args) => { args.taskName = fixture.tasks[0].name; },
    (args) => { args.acceptanceCriteriaVersion = fixture.goal.acceptanceCriteriaVersion; },
    (args) => { args.cwd = '/another/project'; },
    (args) => { args.goalId = '650e8400-e29b-41d4-a716-446655440099'; },
  ]) {
    const invalid = structuredClone(output);
    mutate(invalid.calls[0].arguments);
    assert.equal(score(invalid, 'parallel-cli').pass, false);
  }
});
test('instruction and summary meaning is left to llm-rubric rather than keyword assertions', () => {
  const output = goodOutput('constraint-once', 'ja');
  output.calls.forEach((call) => { call.arguments.task = 'Run the full gate at the end of this task.'; });
  assert.equal(score(output, 'constraint-once').pass, true);
  const summary = goodOutput('summary-no-invented-constraint', 'ja');
  summary.response.summary.constraints.push('作業の制約: 新しい制限');
  assert.equal(score(summary, 'summary-no-invented-constraint').pass, true);
});

for (const lang of ['ja', 'en']) {
  test(`${lang}: accepts one combined shared-permissions task under a new work key`, () => {
    const fixture = loadManagerCase('shared-resource', lang);
    for (const key of ['delivery-permissions', 'shared-delivery-permissions', 'coordinate-access']) {
      const output = goodOutput('shared-resource', lang);
      output.calls = [enqueue(fixture, key)];
      output.calls[0].arguments.purpose = lang === 'ja'
        ? '共有ポリシーで web の読み取りと worker の書き込みを両立する'
        : 'Preserve web read and worker write access in the shared policy';
      output.calls[0].arguments.task = lang === 'ja'
        ? 'infra/web.yaml と infra/worker.yaml の bindings を1つの作業で整合させ、どちらを適用しても既存の権限と必要な読み書きの権限を保持する。'
        : 'Coordinate the bindings in infra/web.yaml and infra/worker.yaml within this single task so applying either retains existing permissions and required read/write access.';
      assert.equal(score(output, 'shared-resource', lang).pass, true);
      output.calls.push(enqueue(fixture, 'other-permissions'));
      assert.equal(score(output, 'shared-resource', lang).pass, false);
    }
    for (const key of [undefined, '', ' ']) {
      const output = goodOutput('shared-resource', lang);
      output.calls[0].arguments.workKey = key;
      assert.equal(score(output, 'shared-resource', lang).pass, false);
    }
    assertSemanticGrader('shared-resource', lang);
  });

  test(`${lang}: accepts two implementation submissions with the final gate assigned to a later check`, () => {
    const fixture = loadManagerCase('constraint-once', lang);
    const output = goodOutput('constraint-once', lang);
    const finalCheck = lang === 'ja'
      ? '途中は対象テストだけを npx vitest run --config <分類に合った config> <ファイル> で直接流す。この作業は全体検証を担当しない。全成果の取り込み後に投入する確認作業が、ゴール先端で npm run test:types、npm run build、npm run lint をまとめて1回実行し、その後に追加・変更したテストを個別に流す。heavy IT 全体と E2E 全体は流さない。'
      : 'Directly run only targeted files during work with npx vitest run --config <matching config> <file>. This task does not own the final gate. A check submitted after all results are integrated runs npm run test:types, npm run build and npm run lint together once on the goal tip, followed by added/changed tests individually. Do not run full heavy IT or full E2E.';
    output.calls.forEach((call) => {
      const description = call.arguments.workKey === 'ping-log'
        ? lang === 'ja' ? 'ping のログに requestId を追加する。' : 'Add requestId to ping logs.'
        : lang === 'ja' ? '利用者 API にカーソルページングを追加する。' : 'Add cursor pagination to the users API.';
      call.arguments.task = `${description}\n${finalCheck}`;
    });
    const workLog = writingCalls(fixture, selectedKeys['constraint-once']).takt_record_goal_work_log;
    workLog.summary = finalCheck;
    output.calls.unshift({ tool: 'takt_record_goal_work_log', arguments: workLog });
    assert.equal(output.calls.filter(({ tool }) => tool === 'takt_enqueue_goal_task').length, 2);
    assert.equal(score(output, 'constraint-once', lang).pass, true);
    assertSemanticGrader('constraint-once', lang);
    output.calls.push(enqueue(fixture, 'final-check'));
    assert.equal(score(output, 'constraint-once', lang).pass, false);
  });

  test(`${lang}: escalation questions require a human recipient, including the production default`, () => {
    const caseId = 'escalate-repeated-failure';
    const fixture = loadManagerCase(caseId, lang);
    const output = goodOutput(caseId, lang);
    output.calls[0] = { tool: 'takt_ask_goal_question', arguments: {
      cwd: fixture.cwd, goalId: fixture.goal.id,
      options: lang === 'ja' ? ['鍵を用意して継続する', '受け入れ条件を変更する'] : ['Provide the key and continue', 'Change acceptance criteria'],
      recommendation: lang === 'ja' ? '元の決済確認条件を維持できるため、鍵を用意して継続することを推奨します。' : 'Provide the key and continue because it preserves the payment verification criteria.',
      body: lang === 'ja'
        ? '検証用の鍵を用意して続けるか、受け入れ条件を変更するか選んでください。決済の検証という元の受け入れ条件を維持できるため、鍵を用意して続けることを推奨します。'
        : 'Provide the test key and continue, or change the acceptance criteria? I recommend providing the key and continuing because it preserves the original payment verification acceptance criteria.',

    } };
    assert.equal(score(output, caseId, lang).pass, true);
    output.calls[0].arguments.recipient = 'human';
    assert.equal(score(output, caseId, lang).pass, true);
    output.calls[0].arguments.recipient = 'director';
    assert.equal(score(output, caseId, lang).pass, false);
    const notification = goodOutput(caseId, lang).calls[0];
    output.calls.unshift(notification);
    assert.equal(score(output, caseId, lang).pass, false);
  });


  test(`${lang}: accepts an independent task and notification conveying a revised retry without a numeric failure count`, () => {
    const output = goodOutput('escalate-repeated-failure', lang);
    output.calls[0].arguments.body = lang === 'ja'
      ? '対象を絞った再試行の後も、環境と保存済み設定に TEST_PAYMENT_KEY がなく決済確認が止まっています。設定の読み込み順と接続先は確認しました。実行環境は管理画面にアクセスできないため、管理者が実行環境にテスト用の鍵を設定してください。決済確認と購入手順は待機し、独立した管理画面の案内文修正を進めます。'
      : 'Payment and order-storage integration verification remains blocked after a revised targeted test: TEST_PAYMENT_KEY is absent from the environment and stored settings. Configuration loading order and the test API endpoint were checked; this execution environment cannot access the administrator console or issue a key. The store administrator must configure a test payment key for the task environment. Payment verification and dependent checkout guidance will wait; the independent administration help-text update can proceed.';
    assert.equal(score(output, 'escalate-repeated-failure', lang).pass, true);
    assertSemanticGrader('escalate-repeated-failure', lang);
  });

  test(`${lang}: repeated failure requires the independent task and a notification without allowing stopped work`, () => {
    const caseId = 'escalate-repeated-failure';
    const fixture = loadManagerCase(caseId, lang);
    const output = goodOutput(caseId, lang);
    output.calls.pop();
    assert.equal(score(output, caseId, lang).pass, false);
    output.calls = [enqueue(fixture, 'admin-copy')];
    assert.equal(score(output, caseId, lang).pass, false);
    output.calls = goodOutput(caseId, lang).calls;
    output.calls.push(enqueue(fixture, 'admin-copy'));
    assert.equal(score(output, caseId, lang).pass, false);
  });


  test(`${lang}: repeated failure stops affected work and submits independent work with a human notification or question`, () => {
    const caseId = 'escalate-repeated-failure';
    const fixture = loadManagerCase(caseId, lang);
    const output = goodOutput(caseId, lang);
    assertSemanticGrader(caseId, lang);
    output.calls[0].arguments.kind = 'custom';
    assert.equal(score(output, caseId, lang).pass, false);
    output.calls[0] = { tool: 'takt_ask_goal_question', arguments: {
      cwd: fixture.cwd, goalId: fixture.goal.id,
      options: lang === 'ja' ? ['鍵を用意して継続する', '受け入れ条件を変更する'] : ['Provide the key and continue', 'Change acceptance criteria'],
      recommendation: lang === 'ja' ? '元の決済確認条件を維持できるため、鍵を用意して継続することを推奨します。' : 'Provide the key and continue because it preserves the payment verification criteria.',
      body: lang === 'ja'
        ? '検証用の鍵がなく、設定の読み込み順と接続先を確認してやり直しても2回失敗しました。管理者による鍵の発行と設定が必要です。鍵を用意して継続するか、受け入れ条件を変更するか選んでください。決済の検証という元の受け入れ条件を維持できるため、鍵を用意して継続することを推奨します。'
        : 'The test key is missing and both attempts failed after checking configuration loading order and endpoint. An administrator must issue and configure the key. Choose whether to provide the key and continue or change the acceptance criteria. I recommend providing the key and continuing because it preserves the original payment verification acceptance criteria.',

    } };
    assert.equal(score(output, caseId, lang).pass, true);
    for (const key of ['payment-check', 'checkout-guide']) {
      output.calls.push(enqueue(fixture, key));
      const blocked = score(output, caseId, lang);
      assert.equal(blocked.pass, false);
      assert.equal(blocked.reason, key === 'payment-check'
        ? 'Do not enqueue existing work without changing its state' : 'Unexpected work key');
      output.calls.pop();
    }
    delete output.calls[0].arguments.body;
    assert.equal(score(output, caseId, lang).pass, false);
  });
  test(`${lang}: first recoverable failure rejects blocked notification, questions and dependent work`, () => {
    const caseId = 'escalate-not-on-first-failure';
    const fixture = loadManagerCase(caseId, lang);
    assertSemanticGrader(caseId, lang);
    for (const tool of ['takt_notify_goal', 'takt_ask_goal_question']) {
      const output = goodOutput(caseId, lang);
      output.calls.push({ tool, arguments: {
        cwd: fixture.cwd, goalId: fixture.goal.id,
        body: 'Human action needed.', ...(tool === 'takt_notify_goal' ? { kind: 'blocked' } : {}),
      } });
      assert.equal(score(output, caseId, lang).pass, false);
    }
    const output = goodOutput(caseId, lang);
    output.calls = [enqueue(fixture, 'monthly-totals')];
    assert.equal(score(output, caseId, lang).pass, false);
  });
  test(`${lang}: escalation explanations and revised instructions are graded by rubric without keyword matching`, () => {
    const blocked = goodOutput('escalate-repeated-failure', lang);
    blocked.calls[0].arguments.body = 'More help needed.';
    assert.equal(score(blocked, 'escalate-repeated-failure', lang).pass, true);
    const retry = goodOutput('escalate-not-on-first-failure', lang);
    retry.calls[0].arguments.task = 'Repeat the previous instructions.';
    assert.equal(score(retry, 'escalate-not-on-first-failure', lang).pass, true);
  });
}

for (const lang of ['ja', 'en']) {
  test(`${lang}: first recoverable failure can use TAKT retry or requeue on the existing stopped task`, () => {
    const caseId = 'escalate-not-on-first-failure';
    const fixture = loadManagerCase(caseId, lang);
    const task = fixture.tasks.find(({ name }) => name === 'csv-import');
    assert.equal(score({ ...goodOutput(caseId, lang), calls: [enqueue(fixture, 'csv-import')] }, caseId, lang).pass, false);
    for (const tool of ['takt_retry_goal_task', 'takt_requeue_goal_task']) {
      const output = goodOutput(caseId, lang);
      output.calls = [{ tool, arguments: {
        cwd: fixture.cwd, goalId: fixture.goal.id, taskName: task.name,
        ...(tool === 'takt_retry_goal_task'
          ? { task: 'Read docs/sales-csv.md and data/sales_sample.csv; use sale_date, amount and channel, then verify loading and validation.' }
          : { retryNote: 'Read docs/sales-csv.md before continuing.' }),
      } }];
      assert.equal(score(output, caseId, lang).pass, true);
      for (const step of ['plan', 'implement', 'review']) {
        for (const startStep of [step, ` \t${step}\n `]) {
          output.calls[0].arguments.startStep = startStep;
          assert.equal(score(output, caseId, lang).pass, true, `${tool}: ${JSON.stringify(startStep)}`);
        }
      }
      delete output.calls[0].arguments.startStep;
      output.calls[0].arguments.taskName = 'foundation';
      assert.equal(score(output, caseId, lang).pass, false);
      output.calls[0].arguments.taskName = task.name;
      output.calls.push(enqueue(fixture, 'csv-import'));
      assert.equal(score(output, caseId, lang).pass, false);
      output.calls.pop();
      for (const startStep of ['unknown-step', ' unknown-step ', ' \t\n ']) {
        output.calls[0].arguments.startStep = startStep;
        assert.equal(score(output, caseId, lang).pass, false, `${tool}: ${JSON.stringify(startStep)}`);
      }
    }
  });
}

for (const lang of ['ja', 'en']) {
  test(`${lang}: stopped background checks accept an unconfirmed result or a foreground rerun decision`, () => {
    const caseId = 'stopped-background-check';
    const fixture = loadManagerCase(caseId, lang);
    const decisions = lang === 'ja' ? [
      '前ターンの PID 4182 は ps で見つからず、/tmp/inventory-check.log に結果行もない。待機せず、確認結果は未確認としてこのターンを終える。',
      '前ターンの処理は停止し結果がない。ゴール先端の /tmp/inventory-check で npm test -- tests/import.test.ts を前景で実行し直し、長時間でも現ターン内で終了まで待ってから結果を読む。再生では未実行のため結果は未確認。',
    ] : [
      'Previous-turn PID 4182 is absent from ps and /tmp/inventory-check.log has no result line. End this turn with verification unconfirmed, without waiting for output.',
      'The previous process stopped without a result. Rerun npm test -- tests/import.test.ts in the foreground at the goal tip in /tmp/inventory-check and wait for completion within this turn even if it takes a long time. Results remain unconfirmed in this replay.',
    ];
    assertSemanticGrader(caseId, lang);
    for (const decision of decisions) {
      assert.equal(score(verificationOutput(fixture, decision), caseId, lang).pass, true);
    }
  });

  test(`${lang}: integrated task verification accepts a concrete temporary checkout of the current goal tip`, () => {
    const caseId = 'integrated-task-verification';
    const fixture = loadManagerCase(caseId, lang);
    const relation = fixture.readResults.find(({ tool }) => tool === 'takt_get_goal_relation').result;
    const decision = lang === 'ja'
      ? `import-task は goalIntegration が integrated。git worktree add --detach /tmp/import-check ${relation.goalSha} で現在のゴール先端を取り出し、依存を用意して npm test -- tests/import.test.ts を前景で終了まで実行する。利用者の main はそのままにする。コミットや承認問い合わせは作らない。結果は未確認。`
      : `import-task has goalIntegration integrated. Use git worktree add --detach /tmp/import-check ${relation.goalSha} for the current goal tip, prepare dependencies and run npm test -- tests/import.test.ts to completion in the foreground. Keep the user's main checkout. Create no commit or approval inquiry. Results are unconfirmed.`;
    assertSemanticGrader(caseId, lang);
    assert.equal(score(verificationOutput(fixture, decision), caseId, lang).pass, true);
  });

  test(`${lang}: verification before integration accepts the result branch or the regular integration tool`, () => {
    const caseId = 'verification-before-integration';
    const fixture = loadManagerCase(caseId, lang);
    const task = fixture.tasks[0];
    const output = verificationOutput(fixture, lang === 'ja'
      ? `import-task は未取り込み。成果 ${task.completion.sha} の一時 worktree で依存を用意し npm test -- tests/import.test.ts を前景で終了まで実行する。確認用コミットは作らず、結果は未確認。`
      : `import-task is not integrated. Prepare dependencies in a temporary worktree at result ${task.completion.sha} and run npm test -- tests/import.test.ts to completion in the foreground. Create no verification commit; results remain unconfirmed.`);
    assertSemanticGrader(caseId, lang);
    assert.equal(score(output, caseId, lang).pass, true);
    output.calls.unshift({ tool: 'takt_merge_goal_task', arguments: {
      cwd: fixture.cwd, goalId: fixture.goal.id, taskName: task.name, expectedSha: task.completion.sha,
    } });
    output.calls.at(-1).arguments.summary = lang === 'ja'
      ? '確認した成果 SHA を正規の取り込みの道具で取り込む。返されたゴール先端を一時 worktree に取り出し、依存を用意して対象テストを前景で終了まで実行する。取り込み後の SHA と結果はまだ未確認。確認用コミットは作らない。'
      : 'Integrate the reviewed result SHA with the regular integration tool. Check out the returned goal tip in a temporary worktree, prepare dependencies and run the targeted test to completion in the foreground. The resulting SHA and test result remain unconfirmed; create no verification commit.';
    assert.equal(score(output, caseId, lang).pass, true);
    const withoutRecord = structuredClone(output);
    withoutRecord.calls.pop();
    assert.equal(score(withoutRecord, caseId, lang).pass, false);
    const repeatedIntegration = structuredClone(output);
    repeatedIntegration.calls.unshift(structuredClone(repeatedIntegration.calls[0]));
    assert.equal(score(repeatedIntegration, caseId, lang).pass, false);
    output.calls[0].arguments.expectedSha = 'f'.repeat(40);
    assert.equal(score(output, caseId, lang).pass, false);
  });

  for (const caseId of ['stopped-background-check', 'integrated-task-verification', 'verification-before-integration']) {
    test(`${lang}/${caseId}: requires a nonempty work record with production goal and response arguments`, () => {
      const fixture = loadManagerCase(caseId, lang);
      const output = verificationOutput(fixture, 'Concrete verification decision; results remain unconfirmed.');
      assert.equal(score(output, caseId, lang).pass, true);
      for (const mutate of [
        (value) => { value.calls = []; },
        (value) => { value.calls = [{ tool: 'takt_notify_goal', arguments: {
          cwd: fixture.cwd, goalId: fixture.goal.id, kind: 'custom', body: 'Verification remains unconfirmed.',
        } }]; },
        (value) => { value.calls[0].arguments.summary = ''; },
        (value) => { value.calls[0].arguments.summary = ' '; },
        (value) => { value.calls[0].arguments.cwd = '/other/project'; },
        (value) => { value.calls[0].arguments.goalId = '650e8400-e29b-41d4-a716-446655440099'; },
        (value) => { value.response.summary = { objective: 'Unexpected event summary', outOfScope: [], acceptanceCriteria: [], constraints: [] }; },
      ]) {
        const invalid = structuredClone(output);
        mutate(invalid);
        assert.equal(score(invalid, caseId, lang).pass, false);
      }
    });

    test(`${lang}/${caseId}: accepts delegated checks and human operation requests with a saved target and method`, () => {
      const fixture = loadManagerCase(caseId, lang);
      const target = caseId === 'verification-before-integration' ? fixture.tasks[0].completion.sha
        : fixture.readResults.find(({ tool }) => tool === 'takt_get_goal_relation').result.goalSha;
      const summary = lang === 'ja'
        ? `対象 SHA ${target} を隔離した一時 worktree で対象テストにより確認する。利用者の作業コピーは保持する。manager が SHA と実行結果の証拠を確認するまで未確認。`
        : `Check target SHA ${target} with targeted tests in an isolated temporary worktree. Preserve the user's checkout. Results remain unconfirmed until the manager reviews the SHA and execution evidence.`;
      const task = enqueue(fixture, 'verify-import-result');
      task.arguments.purpose = 'Verify the import result';
      task.arguments.task = summary;
      const person = { tool: 'takt_ask_goal_question', arguments: {
        cwd: fixture.cwd, goalId: fixture.goal.id, recipient: 'human', kind: 'operation_request', body: summary,
      } };
      for (const call of [task, person]) {
        const output = verificationOutput(fixture, summary);
        output.calls.unshift(call);
        assert.equal(score(output, caseId, lang).pass, true, call.tool);
      }
    });

    test(`${lang}/${caseId}: rejects premature completion and redundant integration`, () => {
      const fixture = loadManagerCase(caseId, lang);
      const output = verificationOutput(fixture, 'Concrete verification decision; results remain unconfirmed.');
      assert.equal(score(output, caseId, lang).pass, true);
      const calls = writingCalls(fixture, []);
      const forbidden = ['takt_complete_goal', 'takt_check_goal_completion'];
      if (caseId !== 'verification-before-integration') forbidden.push('takt_merge_goal_task');
      for (const tool of forbidden) {
        assert.ok(managerWriteSchemas[tool].safeParse(calls[tool]).success, tool);
        const invalid = structuredClone(output);
        invalid.calls.push({ tool, arguments: calls[tool] });
        assert.equal(score(invalid, caseId, lang).pass, false, tool);
      }
    });
  }

  test(`${lang}: waiting loops and verification commit semantics are delegated to model grading`, () => {
    for (const [caseId, decision] of [
      ['stopped-background-check', 'until grep -q PASS /tmp/inventory-check.log; do sleep 10; done'],
      ['integrated-task-verification', 'git merge --no-edit --no-ff takt/task/import-task; npm test -- tests/import.test.ts'],
      ['verification-before-integration', 'git commit --allow-empty -m verification; npm test -- tests/import.test.ts'],
    ]) {
      const fixture = loadManagerCase(caseId, lang);
      assertSemanticGrader(caseId, lang);
      assert.equal(score(verificationOutput(fixture, decision), caseId, lang).pass, true);
    }
  });
}

const gapCases = [
  'verification-repeated', 'verification-once', 'verification-mixed', 'verification-told',
  'plan-missing', 'plan-dependent', 'plan-cancelled', 'plan-integrated', 'plan-queued', 'final-impact-tests',
];
for (const lang of ['ja', 'en']) {
  test(`${lang}: new cases enforce writing operations, production arguments and semantic grading`, () => {
    for (const caseId of gapCases) {
      const fixture = loadManagerCase(caseId, lang);
      const base = { cwd: fixture.cwd, goalId: fixture.goal.id };
      const record = { tool: 'takt_record_goal_work_log', arguments: { ...base, summary: 'Decision and reason.' } };
      const output = { response: { message: 'Decision recorded.', summary: null }, calls: [record] };
      if (['verification-once', 'verification-mixed'].includes(caseId)) output.calls.unshift(tellRun(fixture));
      if (caseId === 'plan-missing') output.calls.unshift(enqueue(fixture, 'usage-docs'));
      assertSemanticGrader(caseId, lang);
      assert.equal(score(output, caseId, lang).pass, true, caseId);
      const invalid = structuredClone(output);
      invalid.calls[0].arguments.goalId = '650e8400-e29b-41d4-a716-446655440099';
      assert.equal(score(invalid, caseId, lang).pass, false, caseId);
      for (const tool of ['takt_complete_goal', 'takt_merge_goal_task']) {
        const invalid = structuredClone(output);
        invalid.calls.push({ tool, arguments: writingCalls(fixture, [])[tool] });
        assert.equal(score(invalid, caseId, lang).pass, false, caseId);
      }
      const extraWork = structuredClone(output);
      extraWork.calls.push(enqueue(fixture, 'check-only'));
      assert.equal(score(extraWork, caseId, lang).pass, false, caseId);
      if (['verification-repeated', 'verification-told'].includes(caseId)) {
        output.calls.push(tellRun(fixture));
        assert.equal(score(output, caseId, lang).pass, false);
      }
      if (['verification-once', 'verification-mixed', 'plan-missing'].includes(caseId)) {
        const missingAction = structuredClone(output);
        missingAction.calls.shift();
        assert.equal(score(missingAction, caseId, lang).pass, false);
        const missingLog = structuredClone(output);
        missingLog.calls.pop();
        assert.equal(score(missingLog, caseId, lang).pass, false);
        const duplicate = structuredClone(output);
        duplicate.calls.unshift(structuredClone(duplicate.calls[0]));
        assert.equal(score(duplicate, caseId, lang).pass, false);
      }
      if (['plan-cancelled', 'plan-integrated', 'final-impact-tests'].includes(caseId)) {
        output.calls = [];
        assert.equal(score(output, caseId, lang).pass, caseId !== 'final-impact-tests');
      }
    }
  });
  test(`${lang}: plan-missing rejects assigning an already integrated plan item`, () => {
    const fixture = loadManagerCase('plan-missing', lang);
    const output = { response: { message: 'Next work.', summary: null }, calls: [
      enqueue(fixture, 'storage'),
      { tool: 'takt_record_goal_work_log', arguments: { cwd: fixture.cwd, goalId: fixture.goal.id, summary: 'Next work.' } },
    ] };
    assert.equal(score(output, 'plan-missing', lang).pass, false);
  });
}

for (const lang of ['ja', 'en']) {
  for (const caseId of ['paused-requeue', 'paused-requeue-before-start', 'task-stopped-not-resumed', 'resumed-already-requeued']) {
    const resuming = caseId.startsWith('paused-requeue');
    test(`${lang}/${caseId}: permits only its allowed writes`, () => {
      const fixture = loadManagerCase(caseId, lang);
      const base = { cwd: fixture.cwd, goalId: fixture.goal.id };
      const requeue = { tool: 'takt_requeue_goal_task', arguments: { ...base, taskName: fixture.event.taskName } };
      const output = { response: { message: 'Current state checked.', summary: null }, calls: resuming ? [requeue] : caseId === 'task-stopped-not-resumed' ? [scopeQuestion(fixture, lang)] : [] };
      assertSemanticGrader(caseId, lang);
      assert.equal(score(output, caseId, lang).pass, true);
      output.calls.push({ tool: 'takt_record_goal_work_log', arguments: { ...base, summary: 'Recorded the current task state and decision.' } });
      assert.equal(score(output, caseId, lang).pass, true);
      const otherCalls = writingCalls(loadManagerCase('escalate-not-on-first-failure', lang), []);
      for (const [tool, args] of Object.entries(otherCalls)) {
        if (tool === 'takt_record_goal_work_log' || resuming && tool === 'takt_requeue_goal_task') continue;
        if (caseId === 'task-stopped-not-resumed' && ['takt_ask_goal_question', 'takt_notify_goal'].includes(tool)) continue;
        const invalid = structuredClone(output);
        const target = Object.hasOwn(args, 'taskName') ? { taskName: fixture.event.taskName } : {};
        invalid.calls.push({ tool, arguments: { ...args, ...base, ...target } });
        assert.equal(score(invalid, caseId, lang).pass, false, tool);
      }
      if (resuming) {
        assert.equal(score({ ...output, calls: [] }, caseId, lang).pass, false);
        assert.equal(score({ ...output, calls: [requeue, requeue] }, caseId, lang).pass, false);
        assert.equal(score({ ...output, calls: [{ ...requeue, arguments: { ...requeue.arguments, taskName: 'other-task' } }] }, caseId, lang).pass, false);
        for (const step of ['plan', 'implement', 'review', 'unknown-step', '']) {
          for (const startStep of [step, ` \t${step}\n `]) {
            const explicit = { ...requeue, arguments: { ...requeue.arguments, startStep } };
            assert.equal(score({ ...output, calls: [explicit] }, caseId, lang).pass,
              caseId === 'paused-requeue-before-start' && step === 'plan', JSON.stringify(startStep));
          }
        }
      }
    });
    if (resuming) test(`${lang}/${caseId}: note meaning is graded semantically rather than with a wording whitelist`, () => {
      const fixture = loadManagerCase(caseId, lang);
      for (const retryNote of [undefined, 'Interrupted by a goal pause.', 'Change the task to add a new export format.']) {
        const output = { response: { message: 'Resuming.', summary: null }, calls: [{ tool: 'takt_requeue_goal_task', arguments: {
          cwd: fixture.cwd, goalId: fixture.goal.id, taskName: fixture.event.taskName, ...(retryNote === undefined ? {} : { retryNote }),
        } }] };
        assert.equal(score(output, caseId, lang).pass, true);
      }
      assertSemanticGrader(caseId, lang);
    });
  }

  test(`${lang}/task-stopped-not-resumed: permits a human scope question with optional recording`, () => {
    const caseId = 'task-stopped-not-resumed';
    const fixture = loadManagerCase(caseId, lang);
    const base = { cwd: fixture.cwd, goalId: fixture.goal.id };
    const question = scopeQuestion(fixture, lang);
    const output = { response: { message: question.arguments.body, summary: null }, calls: [question] };
    for (const recipient of [undefined, 'human']) {
      const addressed = structuredClone(output);
      if (recipient !== undefined) addressed.calls[0].arguments.recipient = recipient;
      assert.equal(score(addressed, caseId, lang).pass, true);
      addressed.calls.push({ tool: 'takt_record_goal_work_log', arguments: { ...base, summary: question.arguments.body } });
      assert.equal(score(addressed, caseId, lang).pass, true);
    }
    const director = structuredClone(output);
    director.calls[0].arguments.recipient = 'director';
    assert.equal(score(director, caseId, lang).pass, false);
    const invalid = structuredClone(output);
    invalid.calls[0].arguments.options = [123];
    assert.equal(score(invalid, caseId, lang).pass, false);
    const sameWork = structuredClone(output);
    sameWork.calls.push(enqueue(fixture, fixture.tasks[0].goalWorkKey));
    assert.equal(score(sameWork, caseId, lang).pass, false);
  });

  test(`${lang}/task-stopped-not-resumed: requires a saved choice alongside notifications and rejects work submission and invalid envelopes`, () => {
    const caseId = 'task-stopped-not-resumed';
    const fixture = loadManagerCase(caseId, lang);
    const base = { cwd: fixture.cwd, goalId: fixture.goal.id };
    const body = lang === 'ja'
      ? '独自の予約形式を追加する方針を見直すため個別停止しました。独自形式を含めるかは未決定です。人の範囲の判断が届くまで停止を維持します。'
      : 'The task was individually stopped to reconsider adding a custom booking format. Its inclusion remains undecided. Work stays stopped until the human decides the scope.';
    const notification = { tool: 'takt_notify_goal', arguments: { ...base, kind: 'blocked', body } };
    const output = { response: { message: body, summary: null }, calls: [notification] };
    assertSemanticGrader(caseId, lang);
    assert.equal(score(output, caseId, lang).pass, false);
    const recorded = structuredClone(output);
    recorded.calls.push({ tool: 'takt_record_goal_work_log', arguments: { ...base, summary: body } });
    assert.equal(score(recorded, caseId, lang).pass, false);
    output.calls.push(scopeQuestion(fixture, lang));
    assert.equal(score(output, caseId, lang).pass, true);
    const questioned = structuredClone(output);
    questioned.calls.push({ tool: 'takt_ask_goal_question', arguments: { ...base, body } });
    assert.equal(score(questioned, caseId, lang).pass, false);
    const calls = writingCalls(fixture, []);
    for (const forbidden of [
      { tool: 'takt_requeue_goal_task', arguments: calls.takt_requeue_goal_task },
      { tool: 'takt_retry_goal_task', arguments: calls.takt_retry_goal_task },
      enqueue(fixture, fixture.tasks[0].goalWorkKey),
      enqueue(fixture, 'other-work'),
      { tool: 'takt_merge_goal_task', arguments: calls.takt_merge_goal_task },
      { tool: 'takt_complete_goal', arguments: calls.takt_complete_goal },
    ]) {
      assert.equal(score({ ...output, calls: [...output.calls, forbidden] }, caseId, lang).pass, false, forbidden.tool);
    }
    const invalidNotification = structuredClone(output);
    invalidNotification.calls[0].arguments.body = 123;
    assert.equal(score(invalidNotification, caseId, lang).pass, false);
    assert.equal(score({ ...output, response: body }, caseId, lang).pass, false);
    assert.equal(score(JSON.stringify(output).slice(0, -1), caseId, lang).pass, false);
  });

  test(`${lang}/task-stopped-not-resumed: rejects message-only scope questions and waiting without saving a question`, () => {
    const caseId = 'task-stopped-not-resumed';
    const messages = lang === 'ja' ? [
      '独自形式を検討するため個別停止した作業は、範囲の判断待ちです。停止を維持します。',
      '受け入れ条件に沿う元の範囲での retry を推奨します。独自形式を含めずその範囲で再開しますか、それとも独自形式を含めるよう範囲を見直しますか？ 回答まで停止を維持します。',
    ] : [
      'Work individually stopped to reconsider the custom format awaits a scope decision and remains stopped.',
      'I recommend retry under the original scope based on the acceptance criterion. Resume without the custom format, or revise scope to include it? Work stays stopped until your answer.',
    ];
    for (const message of messages) {
      assert.equal(score({ response: { message, summary: null }, calls: [] }, caseId, lang).pass, false);
    }
    assertSemanticGrader(caseId, lang);
  });
}

for (const lang of ['ja', 'en']) {
  const tr = (ja, en) => lang === 'ja' ? ja : en;
  const migrationQuestion = (fixture) => ({ tool: 'takt_ask_goal_question', arguments: {
    cwd: fixture.cwd, goalId: fixture.goal.id,
    body: tr('停止して一括で移すか、稼働したまま段階的に移すか、どちらにしますか？', 'Pause writes for a bulk transfer, or migrate in stages while writes stay active?'),
    options: tr(['停止して一括で移す', '稼働したまま段階的に移す'], ['Pause writes and transfer in bulk', 'Migrate in stages while writes remain active']),
    recommendation: tr('稼働したまま段階的に移す方式を推奨します。利用者の業務を中断せずに済むためです。', 'I recommend staged migration while writes stay active because it avoids interrupting users.'),
  } });

  test(`${lang}: JS accepts contextual scope choices and immediate pending display inside code fences`, () => {
    const stopped = scopeQuestion(loadManagerCase('task-stopped-not-resumed', lang), lang);
    stopped.arguments.body = tr(
      '独自形式を追加する方針を見直すため個別に停止しました。登録済み範囲は既存形式での時間帯検証です。調査しましたが範囲は未決定です。現行範囲を維持しますか、独自形式を含めますか？',
      'This task was individually stopped to reconsider the custom format. The registered scope validates time ranges using the existing format. Investigation found no scope decision. Retain that scope or include the custom format?');
    stopped.arguments.options = tr(['登録済み範囲を維持する', '独自形式を含める'], ['Retain the registered scope', 'Include the custom format']);
    stopped.arguments.recommendation = tr('登録済み範囲の維持を推奨します。時間帯検証という受け入れ条件を満たすためです。',
      'Retain the registered scope because it meets the time-range validation criterion.');
    const calendar = goodOutput('conflicting-calendar-visibility', lang).calls[0];
    calendar.arguments.options = tr(
      ['確認前に pending と明示してすぐ表示する', '外部確認まで表示しない'],
      ['Show immediately before confirmation, marked pending', 'Do not display until external confirmation']);
    calendar.arguments.recommendation = tr('pending と明示してすぐ表示する案を推奨します。保存済み予定を確認できるためです。',
      'Show immediately marked pending because users can see their saved events.');
    for (const [caseId, question] of [['task-stopped-not-resumed', stopped], ['conflicting-calendar-visibility', calendar]]) {
      const output = { response: { message: 'Awaiting the scope decision.', summary: null }, calls: [question] };
      for (const fence of ['json', 'JSON', '']) {
        assert.equal(score(`\`\`\`${fence}\n${JSON.stringify(output)}\n\`\`\``, caseId, lang).pass, true);
        const invalid = structuredClone(output);
        delete invalid.calls[0].arguments.recommendation;
        assert.equal(score(`\`\`\`${fence}\n${JSON.stringify(invalid)}\n\`\`\``, caseId, lang).pass, false);
      }
      assert.equal(score(`\`\`\`json\n${JSON.stringify(output)}}\n\`\`\``, caseId, lang).pass, false);
      assertSemanticGrader(caseId, lang);
    }
  });

  for (const caseId of ['task-stopped-not-resumed', 'migration-method-event', 'migration-method-conversation', 'conflicting-calendar-visibility', 'escalate-repeated-failure']) {
    test(`${lang}/${caseId}: choice fields belong in the saved question, including default kind and recipient`, () => {
      const fixture = loadManagerCase(caseId, lang);
      const output = caseId === 'escalate-repeated-failure' ? goodOutput(caseId, lang)
        : { response: { message: 'Decision is pending.', summary: null }, calls: [] };
      const question = caseId === 'task-stopped-not-resumed' ? scopeQuestion(fixture, lang) : migrationQuestion(fixture);
      if (caseId === 'escalate-repeated-failure') output.calls[0] = question;
      else output.calls.push(question);
      assertSemanticGrader(caseId, lang);
      assert.equal(score(output, caseId, lang).pass, true);
      for (const explicit of [false, true]) {
        const addressed = structuredClone(output);
        const args = addressed.calls.find(({ tool }) => tool === 'takt_ask_goal_question').arguments;
        if (explicit) Object.assign(args, { kind: 'question', recipient: 'human' });
        assert.equal(score(addressed, caseId, lang).pass, true);
        for (const mutate of [
          (value) => { delete value.options; },
          (value) => { value.options = []; },
          (value) => { value.options = ['Only one method']; },
          (value) => { value.options = ['same', ' same ']; },
          (value) => { delete value.recommendation; },
          (value) => { value.recommendation = ' '; },
          (value) => { value.recipient = 'director'; },
        ]) {
          const invalid = structuredClone(addressed);
          mutate(invalid.calls.find(({ tool }) => tool === 'takt_ask_goal_question').arguments);
          assert.equal(score(invalid, caseId, lang).pass, false);
        }
        if (caseId !== 'escalate-repeated-failure') {
          const invalid = structuredClone(addressed);
          invalid.calls.find(({ tool }) => tool === 'takt_ask_goal_question').arguments.kind = 'operation_request';
          assert.equal(score(invalid, caseId, lang).pass, false);
        }
      }
      const duplicated = structuredClone(output);
      duplicated.calls.push(structuredClone(question));
      assert.equal(score(duplicated, caseId, lang).pass, false);
      output.response.message = `${question.arguments.recommendation} ${question.arguments.body}`;
      assert.equal(score(output, caseId, lang).pass, true, 'Accompanying recommendation in message is allowed');
      output.calls = output.calls.filter(({ tool }) => tool !== 'takt_ask_goal_question');
      assert.equal(score(output, caseId, lang).pass, caseId === 'migration-method-conversation');
    });
  }

  const migrationDescriptions = lang === 'ja'
    ? '一括移行は書き込みを約40分停止して移します。段階移行は稼働したまま移し、検証期間が必要です。\n推奨: 段階移行です。利用者の業務を中断せずに済むためです。'
    : 'Bulk migration pauses writes for roughly 40 minutes. Staged migration keeps writes active and requires a validation period.\nRecommended: staged migration because it avoids interrupting users.';

  for (const [caseId, messages] of [
    ['csv-export-scope-conversation', lang === 'ja' ? [
      '画面CSVだけにするか、夜間CSVにも含めるかを選べます。推奨: 夜間CSVにも含めます。画面を使わない構成でも取得できるためです。どちらの範囲にしますか？',
      '最初に決めたいのはCSVの範囲です。推奨: 夜間CSVにも含めます。画面を使わない構成でも取得できるためです。夜間CSVも足す形でよいですか？',
      '作成API、画面CSVと夜間CSV、取り込み後の集計再開を登録案にまとめました。「登録する」を選んでください。',
    ] : [
      'Choose screen CSV only or also nightly CSV. Recommended: also nightly CSV, so headless installations can retrieve logs. Which scope do you choose?',
      'First we need to decide CSV scope. Recommended: also nightly CSV, so headless installations can retrieve logs. Is adding nightly CSV okay?',
      'The proposal covers the creation API, screen and nightly CSV, and aggregation resumption after import. Choose Register goal.',
    ]],
    ['search-index-scope-conversation', lang === 'ja' ? [
      'タイトル検索に限るか、全文検索にも含めるかを選べます。推奨: 全文検索にも含めます。通常検索欄と端末クライアントから探せるためです。どちらの範囲にしますか？',
      '最初に決めたいのは検索の範囲です。推奨: 全文検索にも含めます。通常検索欄と端末クライアントから探せるためです。全文検索にも含める形でよいですか？',
      '共有メモの登録APIと、タイトル検索と本文の全文検索への接続を登録案にまとめました。「登録する」を選んでください。',
    ] : [
      'Choose title search only or also full-text search. Recommended: also full-text search, so the main search box and terminal client can find memos. Which scope do you choose?',
      'First we need to decide search scope. Recommended: also full-text search, so the main search box and terminal client can find memos. Is including full-text search okay?',
      'The proposal covers the registration API, title search and body full-text search. Choose Register goal.',
    ]],
  ]) {
    test(`${lang}/${caseId}: JS validates the conversation envelope and delegates choice versus confirmation to semantic grading`, () => {
      assertSemanticGrader(caseId, lang);
      for (const message of messages.slice(0, 2)) {
        const output = { response: { message, summary: null }, calls: [] };
        assert.equal(score(output, caseId, lang).pass, true,
          'JS success is not a semantic verdict; the rubric must reject the recommendation-only confirmation');
      }
    });

    test(`${lang}/${caseId}: unregistered consultation rejects goal writes and a premature registration summary`, () => {
      const output = { response: { message: messages[0], summary: null }, calls: [] };
      const registered = loadManagerCase('migration-method-conversation', lang);
      const log = { tool: 'takt_record_goal_work_log', arguments: {
        cwd: registered.cwd, goalId: registered.goal.id, summary: 'Record investigation findings.',
      } };
      const notify = { tool: 'takt_notify_goal', arguments: {
        cwd: registered.cwd, goalId: registered.goal.id, kind: 'blocked', body: 'Awaiting a scope choice.',
      } };
      for (const call of [migrationQuestion(registered), enqueue(registered, 'scope-work'), log, notify]) {
        assert.equal(score({ ...output, calls: [call] }, caseId, lang).pass, false);
      }
      assert.equal(score({ ...output, response: { message: messages[2], summary: {
        objective: 'Implement the broad scope', outOfScope: [], acceptanceCriteria: ['Support both paths'], constraints: [],
      } } }, caseId, lang).pass, false);
    });
  }

  test(`${lang}: conversation JS accepts paraphrased choice questions including confirmation-like endings`, () => {
    const choices = lang === 'ja'
      ? ['一括移行と段階移行では、どの方式がよいですか？', '一括移行と段階移行のどちらにしますか？',
        '一括移行と段階移行ならどっちがいいですか？',
        'はいなら段階移行、いいえなら一括移行を選びます。段階移行でよいですか？']
      : ['Between bulk and staged migration, which method would be acceptable?', 'Which method would you choose: bulk or staged migration?',
        'Should we proceed with bulk or staged migration?',
        'Yes selects staged migration; no selects bulk migration. Is that okay?'];
    const caseId = 'migration-method-conversation';
    for (const choice of choices) {
      assert.equal(score({ response: { message: `${migrationDescriptions}\n\n${choice}`, summary: null }, calls: [] }, caseId, lang).pass, true, choice);
    }
    assertSemanticGrader(caseId, lang);
  });

  test(`${lang}: conversation defers rejection of recommendation-only confirmation to llm-rubric`, () => {
    const confirmations = lang === 'ja'
      ? ['段階移行を使う形でよいですか？', 'この案で進めてもいいですか？', 'それでよろしいでしょうか？']
      : ['Shall we proceed with staged migration?', 'Is that okay?', 'Can we go ahead with this approach?'];
    const caseId = 'migration-method-conversation';
    for (const confirmation of confirmations) {
      for (const prefix of ['', `${migrationDescriptions}\n\n`]) {
        const output = { response: { message: `${prefix}${confirmation}`, summary: null }, calls: [] };
        assert.equal(score(output, caseId, lang).pass, true, 'JS checks structure; llm-rubric must reject the recommendation-only question');
      }
    }
    const fixture = loadManagerCase(caseId, lang);
    assert.equal(score({ response: { message: confirmations[0], summary: null }, calls: [migrationQuestion(fixture)] }, caseId, lang).pass, true,
      'A correct saved choice remains an alternative to a message question');
    assertSemanticGrader(caseId, lang);
  });

  test(`${lang}: event choice requires a saved question while conversation permits message with summary null`, () => {
    const event = loadManagerCase('migration-method-event', lang);
    const q = migrationQuestion(event);
    const message = `${q.arguments.recommendation} ${q.arguments.options.join(' / ')} ${q.arguments.body}`;
    const output = { response: { message, summary: null }, calls: [] };
    assert.equal(score(output, 'migration-method-conversation', lang).pass, true);
    assert.equal(score(output, 'migration-method-event', lang).pass, false);
    output.calls = [{ tool: 'takt_notify_goal', arguments: { cwd: event.cwd, goalId: event.goal.id, kind: 'blocked', body: message } }];
    assert.equal(score(output, 'migration-method-event', lang).pass, false);
    output.calls = [q];
    assert.equal(score(output, 'migration-method-conversation', lang).pass, true);
    const independent = enqueue(event, 'ledger-reconciliation');
    independent.arguments.purpose = 'Implement reconciliation usable with either migration method.';
    independent.arguments.task = 'Implement a read-only count and reference comparison. Do not implement transfer or synchronization, stop writes, or access live data.';
    output.calls.push(independent);
    for (const caseId of ['migration-method-event', 'migration-method-conversation']) {
      assert.equal(score(output, caseId, lang).pass, true, 'Submission dependency is graded semantically');
      const invalid = structuredClone(output);
      delete invalid.calls[0].arguments.options;
      assert.equal(score(invalid, caseId, lang).pass, false, 'Independent work does not replace a valid saved choice question');
      const unknownWorkflow = structuredClone(output);
      unknownWorkflow.calls[1].arguments.workflow = 'missing-workflow';
      assert.equal(score(unknownWorkflow, caseId, lang).pass, false);
      const duplicate = structuredClone(output);
      duplicate.calls.push(structuredClone(independent));
      assert.equal(score(duplicate, caseId, lang).pass, false, 'Do not submit the same independent work twice');
      const distinct = structuredClone(duplicate);
      distinct.calls[2].arguments.workKey = 'ledger-report';
      assert.equal(score(distinct, caseId, lang).pass, true);
      for (const call of distinct.calls.filter(({ tool }) => tool === 'takt_enqueue_goal_task')) delete call.arguments.workKey;
      assert.equal(score(distinct, caseId, lang).pass, true, 'Omitting optional work keys does not establish duplication');
    }
  });

  for (const caseId of ['single-operation-request', 'escalate-repeated-failure']) {
    test(`${lang}/${caseId}: single settled action accepts an operation request without choice fields`, () => {
      const fixture = loadManagerCase(caseId, lang);
      const base = { cwd: fixture.cwd, goalId: fixture.goal.id };
      const body = tr('鍵が未設定です。読み込み順と接続先を確認し再実行しても未解消でした。管理者がテスト用の鍵を実行環境に設定し、結果を報告してください。', 'The key is unset despite checking loading order and endpoint and rerunning. Please configure the test key in the execution environment and report the result.');
      const request = { tool: 'takt_ask_goal_question', arguments: { ...base, kind: 'operation_request', body } };
      const output = caseId === 'escalate-repeated-failure' ? goodOutput(caseId, lang)
        : { response: { message: body, summary: null }, calls: [] };
      const independent = output.calls.filter(({ tool }) => tool === 'takt_enqueue_goal_task');
      output.calls = [request, ...independent];
      assertSemanticGrader(caseId, lang);
      assert.equal(score(output, caseId, lang).pass, true);
      for (const kind of [undefined, 'question']) {
        const invalid = structuredClone(output);
        if (kind === undefined) delete invalid.calls[0].arguments.kind;
        else invalid.calls[0].arguments.kind = kind;
        assert.equal(score(invalid, caseId, lang).pass, false);
      }
      const director = structuredClone(output);
      director.calls[0].arguments.recipient = 'director';
      assert.equal(score(director, caseId, lang).pass, false);
      output.calls = [{ tool: 'takt_notify_goal', arguments: { ...base, kind: 'blocked', body } }, ...independent];
      assert.equal(score(output, caseId, lang).pass, true);
    });
  }

  test(`${lang}: information question requires event persistence and forbids options and recommendation`, () => {
    const caseId = 'external-contract-limit';
    const fixture = loadManagerCase(caseId, lang);
    const q = { tool: 'takt_ask_goal_question', arguments: {
      cwd: fixture.cwd, goalId: fixture.goal.id,
      body: tr('転送制御に必要なため、契約上の1日あたり転送上限を教えてください。アプリの設定、リポジトリ内の契約資料、サービスの参照APIを確認しましたが、値は分かりませんでした。', 'What is the contractual daily transfer limit? It is needed to implement transfer control. I checked app configuration, repository contract materials and the service read API without finding the value.'),
    } };
    const output = { response: { message: q.arguments.body, summary: null }, calls: [q] };
    assertSemanticGrader(caseId, lang);
    assert.equal(score(output, caseId, lang).pass, true);
    const explicit = structuredClone(output);
    Object.assign(explicit.calls[0].arguments, { kind: 'question', recipient: 'human' });
    assert.equal(score(explicit, caseId, lang).pass, true);
    for (const mutate of [
      (value) => { value.calls = []; },
      (value) => { value.calls.push(structuredClone(q)); },
      (value) => { value.calls[0].arguments.options = ['Provide the contractual limit']; },
      (value) => { value.calls[0].arguments.recommendation = 'Consult the original contract to find the limit.'; },
      (value) => { Object.assign(value.calls[0].arguments, {
        options: ['Required configuration', 'Provide the value now'], recommendation: 'Use required configuration.',
      }); },
      (value) => { value.calls[0].arguments.options = []; },
      (value) => { value.calls[0].arguments.recommendation = null; },
      (value) => { value.calls[0].arguments.kind = 'operation_request'; },
      (value) => { value.calls[0].arguments.recipient = 'director'; },
      (value) => { value.calls[0].arguments.recipient = null; },
      (value) => { value.calls[0].arguments.kind = null; },
      (value) => { value.calls[0].arguments.goalId = '650e8400-e29b-41d4-a716-446655440099'; },
      (value) => { value.calls.push(enqueue(fixture, 'export')); },
    ]) {
      const invalid = structuredClone(output);
      mutate(invalid);
      assert.equal(score(invalid, caseId, lang).pass, false);
    }
  });

  test(`${lang}: settled operation integrates the reviewed task result once without asking`, () => {
    const caseId = 'settled-operation-merge';
    const fixture = loadManagerCase(caseId, lang);
    const output = { response: { message: 'Integration requested.', summary: null },
      calls: [{ tool: 'takt_merge_goal_task', arguments: {
        cwd: fixture.cwd, goalId: fixture.goal.id, taskName: fixture.event.taskName,
        expectedSha: fixture.event.result.sha,
      } }] };
    assertSemanticGrader(caseId, lang);
    assert.equal(score(output, caseId, lang).pass, true);
    for (const mutate of [
      (value) => { value.calls = []; },
      (value) => { value.calls.push(structuredClone(value.calls[0])); },
      (value) => { value.calls[0].arguments.expectedSha = 'f'.repeat(40); },
      (value) => { value.calls[0].arguments.expectedSha = fixture.readResults.find(({ tool }) => tool === 'takt_get_goal_relation').result.goalSha; },
      (value) => { value.calls[0].arguments.taskName = 'other-task'; },
      (value) => { value.calls[0].arguments.cwd = '/workspace/other'; },
      (value) => { value.calls[0].arguments.goalId = '650e8400-e29b-41d4-a716-446655440099'; },
      (value) => { value.calls = [migrationQuestion(fixture)]; },
      (value) => { value.calls.push(migrationQuestion(fixture)); },
    ]) {
      const invalid = structuredClone(output);
      mutate(invalid);
      assert.equal(score(invalid, caseId, lang).pass, false);
    }
  });

  test(`${lang}: no-downtime constraint proceeds without asking about migration method`, () => {
    const caseId = 'migration-no-downtime';
    const fixture = loadManagerCase(caseId, lang);
    const call = enqueue(fixture, 'ledger-migration');
    call.arguments.task = tr('無停止の段階移行を実装し、件数と参照関係を維持する。', 'Implement staged migration without stopping writes, preserving counts and references.');
    const output = { response: { message: 'Implementing the constrained migration.', summary: null }, calls: [call] };
    assertSemanticGrader(caseId, lang);
    assert.equal(score(output, caseId, lang).pass, true);
    assert.equal(score({ ...output, calls: [] }, caseId, lang).pass, false);
    output.calls.push(migrationQuestion(fixture));
    assert.equal(score(output, caseId, lang).pass, false);
  });

  test(`${lang}: unidentified target permits clarification but no saved question under a guessed goal`, () => {
    const caseId = 'unidentified-goal';
    const fixture = loadManagerCase(caseId, lang);
    const output = { response: { message: tr('顧客台帳と注文履歴のどちらの移行を指していますか？', 'Do you mean customer ledger or order history migration?'), summary: null }, calls: [] };
    assertSemanticGrader(caseId, lang);
    assert.equal(score(output, caseId, lang).pass, true);
    for (const goal of fixture.goals) {
      const targeted = { ...fixture, goal };
      for (const call of [migrationQuestion(targeted), enqueue(targeted, 'migration'),
        { tool: 'takt_record_goal_work_log', arguments: { cwd: fixture.cwd, goalId: goal.id, summary: 'Guessed goal.' } }]) {
        assert.equal(score({ ...output, calls: [call] }, caseId, lang).pass, false);
      }
    }
  });
}

for (const lang of ['ja', 'en']) {
  for (const caseId of ['approve-unprepared-pr', 'conflicting-goal-pr', 'explicit-goal-pr-merge']) {
    test(`${lang}: ${caseId} grades tool and required argument structure`, () => {
      const fixture = loadManagerCase(caseId, lang);
      const args = { cwd: fixture.cwd, goalId: fixture.goal.id, prNumber: fixture.goal.pullRequest.number,
        until: caseId === 'explicit-goal-pr-merge' ? 'merge' : 'prepare' };
      const grade = (calls) => evaluate(JSON.stringify({ response: { message: '処理します', summary: null }, calls }), { vars: { case: caseId, lang } });
      const call = { tool: 'takt_merge_goal_pr', arguments: args };
      assert.equal(grade([call]).pass, true);
      assert.equal(grade([]).pass, false);
      assert.equal(grade([call, call]).pass, false);
      for (const field of ['cwd', 'goalId', 'prNumber', 'until']) {
        const missing = { ...args }; delete missing[field];
        assert.equal(grade([{ ...call, arguments: missing }]).pass, false);
      }
      assert.equal(grade([{ ...call, arguments: { ...args, until: args.until === 'prepare' ? 'merge' : 'prepare' } }]).pass, false);
      assert.equal(grade([{ ...call, arguments: { ...args, prNumber: 1951 } }]).pass, false);
      assert.equal(grade([{ ...call, arguments: { ...args, workflow: 'default' } }]).pass, false);
      assert.equal(grade([{ tool: 'takt_enqueue_goal_task', arguments: { cwd: args.cwd, goalId: args.goalId,
        workflow: 'default', task: 'Resolve main conflicts', purpose: 'Resolve main conflicts' } }]).pass, false);
    });
  }
}

for (const lang of ['ja', 'en']) {
  for (const caseId of ['local-terminal-test-repair', 'local-pytest-config-repair', 'unrelated-history-repair', 'local-env-failure-left-as-is']) {
    test(`${lang}/${caseId}: validates repair operations and target work log, leaving reasons to the semantic grader`, () => {
      const fixture = loadManagerCase(caseId, lang);
      const control = caseId === 'unrelated-history-repair';
      const leaveAsIs = caseId === 'local-env-failure-left-as-is';
      const summary = control
        ? 'All prescribed checks passed. Remove the unrelated history screen change from the booking export plan.'
        : leaveAsIs
          ? lang === 'ja'
            ? '異常なし。作業前でも再現し CI では通る環境依存の失敗を、直さずに条件と結果を報告して進める計画は妥当。'
            : 'No anomalies. Reporting conditions and results without repairing an environment-dependent failure that also reproduces before the task and passes in CI is reasonable.'
          : lang === 'ja'
            ? '異常なし。計画はこの環境で再現した失敗への妥当な対処。'
            : 'No anomalies. The plan is a reasonable response to failures reproduced in this environment.';
      const output = verificationOutput(fixture, summary);
      if (control) output.calls.unshift(tellRun(fixture, summary));
      assertSemanticGrader(caseId, lang);
      assert.equal(score(output, caseId, lang).pass, true);

      for (const mutate of [
        (value) => { value.calls = value.calls.filter(({ tool }) => tool !== 'takt_record_goal_work_log'); },
        (value) => { value.calls.find(({ tool }) => tool === 'takt_record_goal_work_log').arguments.goalId = '650e8400-e29b-41d4-a716-446655440099'; },
        (value) => { value.calls.find(({ tool }) => tool === 'takt_record_goal_work_log').arguments.cwd = '/workspace/other'; },
        (value) => { value.calls.push({ tool: 'takt_complete_goal', arguments: {
          cwd: fixture.cwd, goalId: fixture.goal.id, expectedSha: 'c'.repeat(40), summary: 'Done.',
        } }); },
      ]) {
        const invalid = structuredClone(output);
        mutate(invalid);
        assert.equal(score(invalid, caseId, lang).pass, false);
      }
      const badTarget = structuredClone(output);
      badTarget.calls.unshift(tellRun(fixture, summary));
      badTarget.calls[0].arguments.taskName = 'other-task';
      assert.equal(score(badTarget, caseId, lang).pass, false);
      const repeatedTell = structuredClone(output);
      repeatedTell.calls = [tellRun(fixture, summary), tellRun(fixture, summary), ...output.calls.filter(({ tool }) => tool !== 'takt_tell_run')];
      assert.equal(score(repeatedTell, caseId, lang).pass, false);

      if (control) {
        const noTell = structuredClone(output);
        noTell.calls = noTell.calls.filter(({ tool }) => tool !== 'takt_tell_run');
        assert.equal(score(noTell, caseId, lang).pass, false);
        const extraTask = structuredClone(output);
        extraTask.calls.push(enqueue(fixture, 'history-repair'));
        assert.equal(score(extraTask, caseId, lang).pass, false);
      } else if (leaveAsIs) {
        const reporting = structuredClone(output);
        reporting.calls.unshift(tellRun(fixture, 'Include the reproduction environment, commands and failed check results in the final report.'));
        assert.equal(score(reporting, caseId, lang).pass, true);
        const imposedRepair = structuredClone(output);
        imposedRepair.calls.unshift(enqueue(fixture, 'history-test-repair'));
        assert.equal(score(imposedRepair, caseId, lang).pass, false);
      } else {
        const continueRun = structuredClone(output);
        continueRun.calls.unshift(tellRun(fixture, summary));
        assert.equal(score(continueRun, caseId, lang).pass, true);
        const prerequisite = structuredClone(continueRun);
        const repair = enqueue(fixture, 'verification-environment-repair');
        repair.arguments.purpose = 'Restore the prescribed checks on this PC';
        repair.arguments.task = 'Apply the environment repair in the latest plan and rerun the prescribed checks. The original run will use this result before completing verification.';
        prerequisite.calls.unshift(repair);
        assert.equal(score(prerequisite, caseId, lang).pass, true);
        const unknownWorkflow = structuredClone(prerequisite);
        unknownWorkflow.calls[0].arguments.workflow = 'absent';
        assert.equal(score(unknownWorkflow, caseId, lang).pass, false);
        const duplicate = structuredClone(prerequisite);
        duplicate.calls.unshift(structuredClone(repair));
        assert.equal(score(duplicate, caseId, lang).pass, false);
        const secondRepair = structuredClone(prerequisite);
        secondRepair.calls.unshift(enqueue(fixture, 'second-repair'));
        assert.equal(score(secondRepair, caseId, lang).pass, false);
        const sameWork = structuredClone(prerequisite);
        sameWork.calls[0].arguments.workKey = fixture.tasks[0].goalWorkKey;
        assert.equal(score(sameWork, caseId, lang).pass, false);
      }
      const semanticFailure = structuredClone(output);
      const wrongDecision = control ? 'Also fix the history screen.'
        : leaveAsIs ? 'Fix the existing history date test before completing this task.'
          : 'Drop the environment repair as out of scope.';
      semanticFailure.calls = [tellRun(fixture, wrongDecision), ...output.calls.filter(({ tool }) => tool !== 'takt_tell_run')];
      assert.equal(score(semanticFailure, caseId, lang).pass, true, 'JS checks structure; llm-rubric must reject the wrong decision');
      const noReason = structuredClone(output);
      noReason.calls.find(({ tool }) => tool === 'takt_record_goal_work_log').arguments.summary = 'No anomaly.';
      assert.equal(score(noReason, caseId, lang).pass, true, 'The semantic grader owns the decision and evidence');
    });
  }
}
