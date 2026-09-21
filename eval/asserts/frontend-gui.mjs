// Expectations stay in the evaluator, outside the model's task and source fixtures.
export const expectations = [
  ['selection-a.tsx', 'REJECT', /Picker|Details|selected/i, /共有|共通|独立|別|それぞれ|連動|反映|同期|接続|更新されない|のまま/],
  ['selection-b.tsx', 'OK', /selected|setSelected|onSelect/i],
  ['buyer-a.tsx', 'OK', /onNameChange/],
  ['buyer-b.tsx', 'REJECT', /buyer\.name|props/i, /直接|変更|代入|書き換え/],
  ['total-a.tsx', 'REJECT', /total|setTotal/i, /Clear|setQuantity\(0\)/],
  ['total-b.tsx', 'OK', /quantity/, /導出|計算|100/],
  ['submit-a.tsx', 'OK', /onSubmit|submit/, /recordClick|記録/],
  ['submit-b.tsx', 'REJECT', /onClick/, /onSubmit/, /二重|2回|２回|重複/],
  ['save-a.tsx', 'REJECT', /Ctrl|onKeyDown|キーボード|ショートカット/i, /status|editing|保存中/],
  ['save-b.tsx', 'OK', /requestSave/, /status|editing/],
  ['row-a.tsx', 'REJECT', /pathname|location|URL|workspaces/i, /共用|共有|再利用|依存|結合|検索|移動|遷移|委譲/],
  ['row-b.tsx', 'OK', /onDelete/],
  ['query-a.tsx', 'OK', /queryKey/, /accountId/],
  ['query-b.tsx', 'REJECT', /queryKey|キー/, /accountId|アカウント/],
  ['subscription-a.tsx', 'REJECT', /channel/, /解除|cleanup|クリーンアップ|unsubscribe/i],
  ['subscription-b.tsx', 'OK', /channel/, /解除|cleanup|クリーンアップ|unsubscribe/i],
  ['context-dispatch.tsx', 'OK', /dispatch|reducer/i],
  ['local-state.tsx', 'OK', /query|useState|入力/, /onSubmit|Enter|通知/],
  ['callback-delegation.tsx', 'OK', /onSelect/],
  ['draft.tsx', 'OK', /draft|下書き/, /Confirm|確定|onConfirm/],
  ['shared-query.tsx', 'OK', /QueryClient|キャッシュ/, /共有/],
];

export function verdictPayload(output) {
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/.exec(output.trim());
  return { text: fenced === null ? output : fenced[1], fenced: fenced !== null };
}

export function parseVerdicts(output) {
  const rows = JSON.parse(verdictPayload(output).text);
  if (!Array.isArray(rows) || rows.length !== expectations.length) {
    throw new Error(`Expected exactly ${expectations.length} verdicts`);
  }
  const expectedPaths = new Set(expectations.map(([file]) => `src/gui-patterns/${file}`));
  const byFile = new Map();
  for (const row of rows) {
    if (row === null || typeof row !== 'object' || !expectedPaths.has(row.file)
      || byFile.has(row.file) || !['OK', 'REJECT'].includes(row.verdict)
      || typeof row.reason !== 'string' || row.reason.trim() === '') {
      throw new Error('Invalid, duplicate, unknown, or missing verdict');
    }
    byFile.set(row.file, row);
  }
  return byFile;
}

export function gradeVerdicts(output, expectedVerdict) {
  let byFile;
  try {
    byFile = parseVerdicts(output);
  } catch (error) {
    return { pass: false, score: 0, reason: `Invalid response: ${error.message}` };
  }
  const selected = expectations.filter(([, verdict]) => verdict === expectedVerdict);
  const failed = [];
  for (const [file, verdict, ...evidence] of selected) {
    const row = byFile.get(`src/gui-patterns/${file}`);
    if (row.verdict !== verdict || evidence.some((pattern) => !pattern.test(row.reason))) {
      failed.push(file);
    }
  }
  const formatNote = verdictPayload(output).fenced
    ? '; format deviation: JSON code fence instead of raw JSON'
    : '';
  return {
    pass: failed.length === 0,
    score: (selected.length - failed.length) / selected.length,
    reason: (failed.length === 0
      ? `${selected.length} ${expectedVerdict} cases matched; reasons still require semantic review`
      : `Wrong verdict or insufficient evidence: ${failed.join(', ')}`) + formatNote,
  };
}
