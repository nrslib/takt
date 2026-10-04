function unwrapProviderOutput(output) {
  try {
    const parsed = JSON.parse(output);
    if (parsed !== null && typeof parsed === 'object' && typeof parsed.output === 'string') {
      return parsed.output;
    }
  } catch {
    return output;
  }
  return output;
}

function hasRejectVerdict(output) {
  return /(?:結果|判定|Result|Verdict)\s*[:：]\s*(?:\*{1,2}|_{1,2}|`)?REJECT/i.test(output)
    || /^(?:#+\s*)?(?:\*{1,2}|_{1,2}|`)?REJECT(?:\*{1,2}|_{1,2}|`)?\s*$/im.test(output);
}

function includesAll(output, patterns) {
  return patterns.every((pattern) => pattern.test(output));
}

function extractFindingSections(output) {
  const id = '[A-Z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+';
  const headingMatches = [...output.matchAll(new RegExp(`^\\s{0,3}#{1,6}\\s+\`?(${id})\\b`, 'gim'))];
  const matches = headingMatches.length >= 2
    ? headingMatches
    : [...output.matchAll(new RegExp(`^.*finding[_ -]?id\\s*[:：]\\s*\`?(${id})\\b.*$`, 'gim'))];

  return matches.map((match, index) => ({
    id: match[1],
    text: output.slice(match.index, matches[index + 1]?.index ?? output.length),
  }));
}

function hasScopedClassification(output, anchor, classification, contradiction) {
  const statements = output
    .split(/\r?\n/)
    .flatMap((line) => line.match(/[^。！？]+[。！？]?/g) ?? []);
  return statements.some((statement) => anchor.test(statement)
    && classification.test(statement)
    && !contradiction.test(statement));
}

export default function assertInitialReviewContractDiscovery(output) {
  const reviewOutput = unwrapProviderOutput(output);
  const repair = /修正(?:案|方針|する|が必要)|変更|fix|remediation|replace|encode|共通化|集約/i;
  const projectionTerms = [
    /preview|プレビュー/i,
    /doctor|診断/i,
    /list|一覧/i,
    /node-text|printNode|text|テキスト/i,
    /node-record|record|レコード/i,
  ];
  const identityConsumers = [
    /JobStore|job-store/i,
    /checkpoint/i,
    /resume|再開|復元/i,
    /event|status|progress|イベント|状態|進捗/i,
    /token|トークン/i,
  ];
  const findingSections = extractFindingSections(reviewOutput);
  const projectionSection = findingSections.find(({ text }) => /control|制御/i.test(text)
    && /worker|実行担当/i.test(text)
    && projectionTerms.filter((pattern) => pattern.test(text)).length >= 3);
  const identitySection = findingSections.find(({ text }) => /pathKey|path-key/i.test(text)
    && /\|/.test(text)
    && /(?:同じ|同一|collision|衝突|上書き|取り違え)/i.test(text));
  const identitySections = findingSections.filter(({ text }) => (
    /pathKey|path-key|JobStore|job-store|checkpoint|resume|再開|復元|event|status|progress|イベント|状態|進捗|token|トークン/i.test(text)
  ));
  const identityEvidence = identitySections.map(({ text }) => text).join('\n');
  const checks = [
    ['reject-verdict', hasRejectVerdict(reviewOutput)],
    ['projection-contract-grounded',
      projectionSection !== undefined
      && /区別|依存|合成|捏造|誤認|fallback|フォールバック/i.test(projectionSection.text)],
    ['projection-paths-covered',
      projectionSection !== undefined
      && /src\/application\.js|inspectNode/i.test(projectionSection.text)
      && includesAll(projectionSection.text, projectionTerms)],
    ['projection-repair-proposed',
      projectionSection !== undefined
      && repair.test(projectionSection.text)],
    ['identity-collision-demonstrated',
      identitySection !== undefined && /\|/.test(identitySection.text)],
    ['identity-consumers-covered', identitySection !== undefined && includesAll(identityEvidence, identityConsumers)],
    ['restart-boundary-covered',
      identitySection !== undefined
      && /再起動|restart/i.test(identityEvidence)
      && /永続|persist|インメモリ|Map|保存状態|別(?:の)?インスタンス/i.test(identityEvidence)],
    ['identity-repair-proposed',
      identitySection !== undefined
      && repair.test(identitySection.text)],
    ['distinct-problems-reported', new Set(findingSections.map(({ id: findingId }) => findingId)).size >= 2],
    ['clean-projection-classified',
      hasScopedClassification(
        reviewOutput,
        /src\/summary\.js|\bsummary\b/i,
        /問題なし|問題ありません|変更不要|修正不要|正しい|維持|worker.{0,30}(?:追加|出力).{0,20}(?:しない|していない)|worker.{0,20}(?:含めず|含まない|付与しない)|no_issue_after_verification|clean/i,
        /壊|欠陥|問題(?:あり|がある)|修正(?:する|が必要|対象)|変更(?:する|が必要|対象)|issue|finding/i,
      )],
    ['working-alternative-classified',
      hasScopedClassification(
        reviewOutput,
        /src\/audit-key\.js|auditKey/i,
        /問題なし|変更不要|修正不要|区別|構造|安全|正しい|no_issue_after_verification|adjacent|別契約/i,
        /壊|欠陥|問題(?:あり|がある)|修正(?:する|が必要|対象)|変更(?:する|が必要|対象)|issue|finding/i,
      )],
    ['adjacent-contract-excluded',
      hasScopedClassification(
        reviewOutput,
        /export-limit|exportReport|export 件数|export関連/i,
        /対象外|別契約|変更しない|out_of_scope/i,
        /壊|欠陥|問題(?:あり|がある)|修正(?:する|が必要|対象)|変更(?:する|が必要|対象)|issue|finding/i,
      )],
  ];
  const failed = checks.filter(([, pass]) => !pass).map(([name]) => name);
  return {
    pass: failed.length === 0,
    score: (checks.length - failed.length) / checks.length,
    reason: failed.length === 0
      ? 'the initial review identifies both changed contracts, their affected paths, and concrete repairs'
      : `failed: ${failed.join(', ')}`,
  };
}
