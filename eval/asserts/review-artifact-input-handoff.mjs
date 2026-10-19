function textOf(output) {
  if (typeof output === 'string') return output;
  if (output && typeof output === 'object') {
    if (typeof output.output === 'string') return output.output;
    if (typeof output.content === 'string') return output.content;
  }
  return String(output ?? '');
}

export default function assertReportHandoff(output, context) {
  const text = textOf(output);
  const id = context?.vars?.case;
  const checks = {
    'follow-up': [
      ['finding', /F-17-unresolved|F-17/.test(text)],
      ['unresolved', /未解消|残(?:って|存)|修正(?:が|を)必要|REJECT|不十分|unresolved/i.test(text)],
    ],
    replan: [
      ['external-receipt', /EXT-LOCK-27/.test(text)],
      ['hold-external', /BLOCKED|外部待機|外部確認待ち|承認待ち/i.test(text)],
      ['no-new-local-work', !/新たな(?:コード|実装|テスト)(?:作業|追加|修正)が必要/.test(text)],
    ],
    synthesis: [
      ['selected-finding', /BACK-4/.test(text)],
      ['reject', /REJECT|差し戻し|不承認/.test(text)],
    ],
    merge: [
      ['review-finding', /AUTH-9/.test(text)],
      ['deny', /approved\s*[=:]\s*(?:false|False)|"approved"\s*:\s*false|承認しない|マージ不可/.test(text)],
    ],
  }[id];
  if (!checks) throw new Error(`Unknown case ${id}`);
  const failed = checks.filter(([, pass]) => !pass).map(([name]) => name);
  return {
    pass: failed.length === 0,
    score: (checks.length - failed.length) / checks.length,
    reason: failed.length === 0 ? `${id}: expected conclusion and receipt found` : `${id}: missing ${failed.join(', ')}`,
  };
}
