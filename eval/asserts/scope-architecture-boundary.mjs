export default function assertArchitectureBoundary(output) {
  const checks = {
    'changed-boundary': /student-export/i.test(output),
    'actionable-finding': /(REJECT|finding|issue|問題|違反|欠陥)/i.test(output),
    'domain-io-boundary': /(domain|ドメイン)/i.test(output) &&
      /(adapter|infrastructure|I\/O|filesystem|file system|境界|依存方向|アダプタ|インフラ|ファイル)/i.test(output),
    impact: /(coupl|dependency|testab|混在|結合|依存|利用.*でき|検証.*でき)/i.test(output),
    'separation-direction': /(move|separate|extract|adapter|移動|分離|抽出|アダプタ)/i.test(output),
    'no-speculative-generalization': !/(strategy pattern|plugin system|registry|factory pattern|future formats|CSV and JSON|将来の形式|プラグイン|レジストリ)/i.test(output),
    'no-structure-proxy': !/(line count|lines long|行数|Object\.freeze|deep freeze|ファイル.*分割|split.*file)/i.test(output),
  };
  const failed = Object.entries(checks).filter(([, pass]) => !pass).map(([name]) => name);
  return {
    pass: failed.length === 0,
    score: (Object.keys(checks).length - failed.length) / Object.keys(checks).length,
    reason: failed.length === 0
      ? 'The present boundary violation and separation direction are identified without speculative generalization.'
      : `Failed checks: ${failed.join(', ')}`,
  };
}
