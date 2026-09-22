// 状態機械と疑似サーバーの動作確認。実行方法は README の「検証したこと」を参照
import assert from 'node:assert/strict';
import { listInquiries, saveReply } from '../src/api/fakeInquiryServer';
import {
  createInitialState,
  deskReducer,
  findSelected,
  hasUnsavedChanges,
  type DeskEvent,
  type DeskState,
} from '../src/screens/inquiryDeskMachine';

let s: DeskState = createInitialState(listInquiries());
const run = (e: DeskEvent) => (s = deskReducer(s, e));

// 初期表示
assert.ok(s.inquiries.length >= 3);
assert.equal(s.selectedId, 'inq-1001');
assert.equal(s.draft, findSelected(s).reply);

// 空白だけ → 保存せず入力不備
run({ type: 'draftChanged', text: '   \n ' });
run({ type: 'saveRequested' });
assert.equal(s.lastOutcome.kind, 'invalid');
assert.equal(s.phase.kind, 'editing');
assert.equal(s.acceptedSaveCount, 0);

// 保存受理 → 連打は拒否され回数は1のまま
run({ type: 'draftChanged', text: '新しい返信' });
assert.equal(s.lastOutcome.kind, 'none');
run({ type: 'saveRequested' });
assert.equal(s.phase.kind, 'saving');
assert.equal(s.acceptedSaveCount, 1);
run({ type: 'saveRequested' });
run({ type: 'saveRequested' });
assert.equal(s.acceptedSaveCount, 1);
assert.equal(s.rejection?.area, 'editor');

// 保存中の切替・入力・戻すは拒否
run({ type: 'inquirySelected', inquiryId: 'inq-1002' });
assert.equal(s.selectedId, 'inq-1001');
assert.equal(s.rejection?.area, 'list');
run({ type: 'draftChanged', text: '混入' });
assert.equal(s.draft, '新しい返信');
run({ type: 'revertRequested' });
assert.equal(s.draft, '新しい返信');
// 保存中でも操作説明は開ける
run({ type: 'helpOpened' });
assert.equal(s.helpOpen, true);
run({ type: 'helpClosed' });

// 実際の非同期保存（約1秒）で成功
if (s.phase.kind !== 'saving') throw new Error('saving expected');
const first = s.phase;
const started = Date.now();
const saved = await saveReply(first.inquiryId, first.reply, { simulateFailure: first.simulateFailure });
assert.ok(Date.now() - started >= 950);
run({ type: 'saveSucceeded', requestId: first.requestId, inquiry: saved });
assert.equal(s.phase.kind, 'editing');
assert.equal(findSelected(s).reply, '新しい返信');
assert.equal(s.lastOutcome.kind, 'saved');
assert.equal(hasUnsavedChanges(s), false);

// 次の保存を失敗させる → 失敗しても1回と数え、下書き保持 → 再試行で成功
run({ type: 'failNextSaveChanged', enabled: true });
run({ type: 'draftChanged', text: '失敗する返信' });
run({ type: 'saveRequested' });
assert.equal(s.acceptedSaveCount, 2);
assert.equal(s.failNextSave, false);
if (s.phase.kind !== 'saving') throw new Error('saving expected');
const failedRequest = s.phase;
await assert.rejects(
  saveReply(failedRequest.inquiryId, failedRequest.reply, { simulateFailure: failedRequest.simulateFailure }),
);
run({ type: 'saveFailed', requestId: failedRequest.requestId, message: 'x' });
assert.equal(s.lastOutcome.kind, 'failed');
assert.equal(s.draft, '失敗する返信');
assert.equal(findSelected(s).reply, '新しい返信');
run({ type: 'saveRequested' });
assert.equal(s.acceptedSaveCount, 3);
if (s.phase.kind !== 'saving') throw new Error('saving expected');
const retry = s.phase;
// 古い要求の結果は無視される
run({ type: 'saveFailed', requestId: failedRequest.requestId, message: 'stale' });
assert.equal(s.phase.kind, 'saving');
run({
  type: 'saveSucceeded',
  requestId: retry.requestId,
  inquiry: await saveReply(retry.inquiryId, retry.reply, { simulateFailure: retry.simulateFailure }),
});
assert.equal(findSelected(s).reply, '失敗する返信');

// 未保存で切替 → 確認待ち。確認中は保存・入力・操作説明を受け付けない。やめる → 下書き保持
run({ type: 'draftChanged', text: '未保存の編集' });
run({ type: 'inquirySelected', inquiryId: 'inq-1002' });
assert.equal(s.phase.kind, 'confirmingSwitch');
run({ type: 'saveRequested' });
assert.equal(s.acceptedSaveCount, 3);
run({ type: 'draftChanged', text: '変更' });
assert.equal(s.draft, '未保存の編集');
run({ type: 'helpOpened' });
assert.equal(s.helpOpen, false);
run({ type: 'switchCancelled' });
assert.equal(s.selectedId, 'inq-1001');
assert.equal(s.draft, '未保存の編集');

// 破棄して切替 → 別の問い合わせの入力が混ざらない
run({ type: 'inquirySelected', inquiryId: 'inq-1002' });
run({ type: 'switchConfirmed' });
assert.equal(s.selectedId, 'inq-1002');
assert.equal(s.draft, findSelected(s).reply);
assert.equal(s.lastOutcome.kind, 'none');
assert.equal(s.inquiries.find((i) => i.id === 'inq-1001')?.reply, '失敗する返信');

// 未変更なら確認なしで切替
run({ type: 'inquirySelected', inquiryId: 'inq-1003' });
assert.equal(s.selectedId, 'inq-1003');

// 保存済みの内容へ戻す
run({ type: 'draftChanged', text: '一時的な編集' });
run({ type: 'revertRequested' });
assert.equal(s.draft, findSelected(s).reply);

// 操作説明中は切替・保存を拒否し、閉じたら編集を続けられる
run({ type: 'draftChanged', text: '説明を見ながら編集' });
run({ type: 'helpOpened' });
run({ type: 'inquirySelected', inquiryId: 'inq-1001' });
run({ type: 'saveRequested' });
assert.equal(s.selectedId, 'inq-1003');
assert.equal(s.phase.kind, 'editing');
assert.equal(s.acceptedSaveCount, 3);
run({ type: 'helpClosed' });
assert.equal(s.draft, '説明を見ながら編集');
run({ type: 'saveRequested' });
assert.equal(s.phase.kind, 'saving');

console.log('all machine checks passed');
