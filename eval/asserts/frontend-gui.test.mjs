import assert from 'node:assert/strict';
import test from 'node:test';
import { expectations, gradeVerdicts, parseVerdicts, verdictPayload } from './frontend-gui.mjs';

const reasons = {
  'selection-a.tsx': 'PickerとDetailsが独立したselectedを持ち、選択を共有していない。',
  'selection-b.tsx': '親のselectedを両方へ渡しonSelectで更新する。',
  'buyer-a.tsx': 'onNameChangeで親へ値を通知する。',
  'buyer-b.tsx': 'buyer.nameへ直接代入している。',
  'total-a.tsx': 'ClearではsetQuantity(0)だけ呼び、totalが残る。',
  'total-b.tsx': 'quantityから100倍の合計を計算する。',
  'submit-a.tsx': 'onSubmitだけが保存し、recordClickは記録する。',
  'submit-b.tsx': 'onClickとonSubmitから保存が二重に呼ばれる。',
  'save-a.tsx': 'Ctrl+Sはstatusを確認せず保存中にも保存できる。',
  'save-b.tsx': '両方がrequestSaveへ渡しstatusがeditingか確認する。',
  'row-a.tsx': 'pathnameとworkspacesのURL構造に依存して検索画面で共用できない。',
  'row-b.tsx': 'onDeleteで呼び出し元に削除を通知する。',
  'query-a.tsx': 'queryKeyにaccountIdを含め別アカウントを区別する。',
  'query-b.tsx': 'queryKeyにaccountIdがなく別アカウントも同じキーになる。',
  'subscription-a.tsx': 'channel変更に追随せず購読解除もない。',
  'subscription-b.tsx': 'channel変更時に解除して再購読する。',
  'context-dispatch.tsx': 'dispatchでProviderのreducerに選択を通知する。',
  'local-state.tsx': 'useStateで入力を持ちEnterでonSubmitへ通知する。',
  'callback-delegation.tsx': 'onSelectで呼び出し元に通知する。',
  'draft.tsx': 'draftは確定までの下書きでConfirmからonConfirmを呼ぶ。',
  'shared-query.tsx': '同じQueryClientのキャッシュを共有する。',
  'bubble-a.tsx': 'Screenがselectを処理した後もonActionでRootのsetRootSelectedIdへ渡している。',
  'bubble-b.tsx': 'selectはreturnでScreenに留めremoveだけをonActionでRootのsetRecordsへ渡す。',
  'guard-a.tsx': 'statusや空入力を確認してもreturnせずonSaveを呼び、拒否した要求を親が実行する。',
  'guard-b.tsx': 'editingと入力を確認し、拒否時はreturnして受理した保存だけをonSaveへ渡す。',
  'mediator-a.tsx': 'startedとfailedはdispatchするがsave成功時の次状態をdispatchせず表示がsavingのままになる。',
  'mediator-b.tsx': 'saveの前後でstarted、succeeded、failedをdispatchしstateのstatusとmessageを表示へ渡す。',
  'confirmation-a.tsx': '破棄確認中でもrequestSaveがonSaveを呼び、保存回数と保存内容を変える。',
  'confirmation-b.tsx': 'requestSaveが確認中の要求をreturnで拒否し、確認待ちの保存回数と保存内容を変えない。',
  'modal-a.tsx': 'custom role dialogは名前とEscape復帰を持つが、Tab移動と背景操作を抑止するfocus境界がない。',
  'modal-b.tsx': 'showModalで背景を抑止し、dialogの名前、開閉focus、Escapeとトリガーへのfocus復帰、確認中の拒否を保つ。',
  'form-action.tsx': 'useActionStateのformActionをformのactionへ渡しpendingと成功・入力エラーのstateを表示する。',
};

function verdicts() {
  return expectations.map(([file, verdict]) => ({
    file: `src/gui-patterns/${file}`, verdict, reason: reasons[file],
  }));
}

test('scores appropriate and defective implementations separately', () => {
  const rows = verdicts();
  assert.equal(gradeVerdicts(JSON.stringify(rows), 'OK').score, 1);
  assert.equal(gradeVerdicts(JSON.stringify(rows), 'REJECT').score, 1);
  rows.find(({ file }) => file.endsWith('local-state.tsx')).verdict = 'REJECT';
  assert.equal(gradeVerdicts(JSON.stringify(rows), 'OK').pass, false);
  assert.equal(gradeVerdicts(JSON.stringify(rows), 'REJECT').pass, true);
});

test('fails duplicate, contradictory, unknown, and missing verdicts', () => {
  const duplicate = verdicts();
  duplicate[1] = { ...duplicate[0], verdict: 'OK' };
  assert.throws(() => parseVerdicts(JSON.stringify(duplicate)), /duplicate/);
  const unknown = verdicts();
  unknown[0].file = 'src/unrelated.tsx';
  assert.throws(() => parseVerdicts(JSON.stringify(unknown)), /unknown/);
  assert.throws(() => parseVerdicts(JSON.stringify(verdicts().slice(1))), /exactly/);
});

test('does not accept correct labels with unrelated evidence', () => {
  const rows = verdicts();
  rows.find(({ file }) => file.endsWith('submit-b.tsx')).reason = 'onClickの名前が不適切';
  const result = gradeVerdicts(JSON.stringify(rows), 'REJECT');
  assert.equal(result.pass, false);
  assert.match(result.reason, /submit-b\.tsx/);
});

test('does not borrow evidence from another file', () => {
  const rows = verdicts();
  const submit = rows.find(({ file }) => file.endsWith('submit-b.tsx'));
  rows[0].reason += submit.reason;
  submit.reason = '修正が必要';
  assert.equal(gradeVerdicts(JSON.stringify(rows), 'REJECT').pass, false);
});

test('fails malformed or empty responses instead of finding stray OK tokens', () => {
  for (const output of ['', 'All files are OK', 'null', '{}', '```json\n[]\n```']) {
    assert.equal(gradeVerdicts(output, 'OK').score, 0);
  }
});

test('accepts concrete explanations without requiring one particular Japanese phrasing', () => {
  const rows = verdicts();
  rows.find(({ file }) => file.endsWith('selection-a.tsx')).reason =
    'PickerとDetailsが別のselectedを保持し、Screenも両者を接続していない。';
  rows.find(({ file }) => file.endsWith('row-a.tsx')).reason =
    '行がwindow.location.pathnameからworkspaceを決め、削除後の遷移を画面へ委譲していない。';
  assert.equal(gradeVerdicts(JSON.stringify(rows), 'REJECT').pass, true);
});

test('scores one fenced JSON payload while retaining its format difference', () => {
  const output = '```json\n' + JSON.stringify(verdicts()) + '\n```';
  assert.equal(verdictPayload(output).fenced, true);
  assert.equal(gradeVerdicts(output, 'OK').pass, true);
  assert.equal(gradeVerdicts(output, 'REJECT').pass, true);
  assert.match(gradeVerdicts(output, 'OK').reason, /format deviation/);
  assert.equal(verdictPayload(JSON.stringify(verdicts())).fenced, false);
  assert.doesNotMatch(gradeVerdicts(JSON.stringify(verdicts()), 'OK').reason, /format deviation/);
});

test('does not select a JSON fragment from prose or contradictory payloads', () => {
  const block = '```json\n' + JSON.stringify(verdicts()) + '\n```';
  for (const output of ['All accepted.\n' + block, block + '\nActually all rejected.', block + '\n' + block]) {
    assert.equal(gradeVerdicts(output, 'OK').pass, false);
  }
});
