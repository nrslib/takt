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

function splitMarkdownRow(line) {
  const cells = [];
  let cell = '';
  let inCode = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '`' && line[index - 1] !== '\\') inCode = !inCode;
    if (character === '|' && !inCode && line[index - 1] !== '\\') {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += character;
    }
  }
  cells.push(cell.trim());
  if (cells[0] === '') cells.shift();
  if (cells.at(-1) === '') cells.pop();
  return cells;
}

function normalizeHeader(cell) {
  return cell.replace(/[`*_]/g, '').trim().toLowerCase();
}

function extractFindingRows(output) {
  const rows = [];
  const lines = output.split('\n');
  for (let index = 0; index < lines.length - 2; index += 1) {
    if (!lines[index].includes('|')) continue;
    const headers = splitMarkdownRow(lines[index]).map(normalizeHeader);
    const findingIndex = headers.findIndex((header) => /^finding[ _-]?id$/.test(header));
    if (findingIndex < 0) continue;
    const separator = splitMarkdownRow(lines[index + 1]);
    if (separator.length !== headers.length || !separator.every((cell) => /^:?-{3,}:?$/.test(cell))) {
      continue;
    }
    for (let rowIndex = index + 2; rowIndex < lines.length && lines[rowIndex].includes('|'); rowIndex += 1) {
      const cells = splitMarkdownRow(lines[rowIndex]);
      if (cells.length === headers.length && cells[findingIndex].trim()) rows.push(cells.join('\n'));
    }
  }
  return rows;
}

function extractFindingBlocks(output) {
  const lines = output.split('\n');
  const starts = [];
  const findingStart = /^\s{0,3}(?:(?:#{1,6}\s*)?(?:finding|指摘)(?:\s+(?:id\s*)?)?[:#-]?\s*`?(?:[A-Z][A-Z0-9-]*-)?\d+\b|#{1,6}\s*(?:\[[^\]]+\]\s*)?`?(?:[A-Z][A-Z0-9-]*-)?\d+\b)/i;
  for (let index = 0; index < lines.length; index += 1) {
    if (findingStart.test(lines[index])) starts.push(index);
  }
  return starts.map((start, index) => lines.slice(start, starts[index + 1] ?? lines.length).join('\n'));
}

function hasNearbyEvidence(output, anchor, evidence) {
  let index = output.indexOf(anchor);
  while (index >= 0) {
    if (evidence.test(output.slice(Math.max(0, index - 500), index + 700))) return true;
    index = output.indexOf(anchor, index + anchor.length);
  }
  return false;
}

function hasStandaloneExecuteEvidence(output, evidence) {
  const token = /\bexecute\b/gi;
  let match = token.exec(output);
  while (match !== null) {
    const prefix = output.slice(0, match.index);
    if (!/\/\s*$/.test(prefix)) {
      const context = output.slice(Math.max(0, match.index - 120), match.index + 120);
      if (evidence.test(context)) return true;
    }
    match = token.exec(output);
  }
  return false;
}

function hasSharedNonCanonicalRepresentation(output) {
  const statements = output
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?。！？])\s+/);
  const implementation = /implementation|resolver|lookup|src\/(?:execution|preview)-target\.js|実装|解決処理|検索処理/i;
  const fixtureOrTest = /fixture|test|e2e|テスト|フィクスチャ/i;
  const shared = /\b(?:same|shared|share(?:s|d|ing)?|both|all)\b|同じ|共有|一致/i;
  const nonCanonical = /raw|bare|short(?:ened)?|step\.name|wrong\s+(?:key\s+)?format|短縮|生の|裸の|誤った(?:キー)?形式|誤形式/i;

  return implementation.test(output) && statements.some((statement) => (
    fixtureOrTest.test(statement)
    && shared.test(statement)
    && (nonCanonical.test(statement)
      || hasStandaloneExecuteEvidence(statement, shared))
  ));
}

function hasNonCanonicalImplementationEvidence(output) {
  const clauses = output
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?。！？;；])\s+|\s*(?:,|，|、|\bwhile\b|一方(?:で)?)\s*/i);
  const implementation = /implementation|resolver|lookup|src\/target-lookup\.js|実装|解決処理|検索処理/i;
  const nonCanonical = /raw|bare|short(?:ened)?|step\.name|wrong\s+(?:key\s+)?format|短縮|生の|裸の|誤った|誤形式/i;
  return clauses.some((clause) => implementation.test(clause) && nonCanonical.test(clause));
}

function hasRejectVerdict(output) {
  return /(?:結果|判定|結論|Result|Verdict)(?:\s*は)?\s*[:：]?\s*(?:\*{1,2}|_{1,2}|`)?REJECT/i.test(output)
    || /^(?:#+\s*)?(?:[^\n（(]{0,40}[（(])?(?:\*{1,2}|_{1,2}|`)?REJECT(?:\*{1,2}|_{1,2}|`)?(?:[）)])?(?:\s+[—–-].*)?\s*$/im.test(output);
}

function hasConnectedPathEvidence(output) {
  const routeStages = [
    /(docs\/configuration\.md|authoritative|owner|正本)/i,
    /(config\/runtime\.json|runtime config|config\.stepTargets|stepTargets|設定)/i,
    /(resolveExternalTarget|target-lookup\.js|target lookup|target の検索|target検索)/i,
    /(resolveExecutionTarget|execution-target\.js|executeStep|execution|terminal(?:\s+string)?|実行経路|実行用|実行結果|terminal\s*文字列)/i,
    /(resolvePreviewTarget|preview-target\.js|previewStep|preview|プレビュー|表示)/i,
    /(e2e|behavior test|回帰テスト|振る舞いテスト)/i,
  ];
  return routeStages.every((stage) => stage.test(output));
}

export default function assertInitialReviewExternalIdentityWiring(output) {
  const reviewOutput = unwrapProviderOutput(output);
  const findingRows = extractFindingRows(reviewOutput);
  const findingBlocks = extractFindingBlocks(reviewOutput);
  const canonicalKey = /\bsample-flow\s*\/\s*execute(?![\w/-])/i;
  const defaultFallback = /default(?:-runner| target| fallback)|デフォルト(?:ターゲット|へ|に)|フォールバック/i;
  const falsePositiveEvidence = /(self[- ]consistent|false positive|green|pass(?:es|ed|ing)?|成功|合格|通(?:る|って|過)|偽陽性|自己整合)/i;
  const testChange = /(?:\b(?:test|e2e)\b|テスト).{0,240}(?:\b(?:add|change|replace|require|assert|cover|update)\b|追加|変更|置換|要求|検証|更新)|(?:\b(?:add|change|replace|require|assert|cover|update)\b|追加|変更|置換|要求|検証|更新).{0,240}(?:\b(?:test|e2e)\b|テスト)/is;
  const adjacentPathPreserved = /(?:outside (?:this|the) finding|out of scope|(?:is|remains|kept) preserved|`?preserved`?\s*:|no (?:issue|change)s?|does not (?:need|require) changes?|separate|distinct contract|対象外|保持(?:する|される)?|維持(?:する|して|される|しており)?|問題なし|変更不要|別(?:の)?契約|契約どおり|混同(?:しない|すべきではない)|この指摘には含めない)/i;
  const hasConnectedIdentityEvidence = hasConnectedPathEvidence(reviewOutput)
    && canonicalKey.test(reviewOutput)
    && defaultFallback.test(reviewOutput);
  const documentedValueTestDemand = hasConnectedIdentityEvidence
    && testChange.test(reviewOutput);
  const hasFalseGreenEvidence = falsePositiveEvidence.test(reviewOutput)
    && /e2e|test|テスト/i.test(reviewOutput)
    && (hasSharedNonCanonicalRepresentation(reviewOutput)
      || (hasNonCanonicalImplementationEvidence(reviewOutput)
        && /fixture|config|設定|テスト/i.test(reviewOutput)
        && /raw|bare|short(?:ened)?|step\.name|wrong\s+(?:key\s+)?format|短縮|生の|裸の|誤った|誤形式/i.test(reviewOutput)));
  const checks = [
    ['reject-verdict', hasRejectVerdict(reviewOutput)],
    ['connected-path-complete', hasConnectedIdentityEvidence],
    ['canonical-key-derived', hasConnectedIdentityEvidence],
    ['canonical-input-falls-to-default', hasConnectedIdentityEvidence],
    ['false-green-explained', hasFalseGreenEvidence],
    ['documented-value-test-required', documentedValueTestDemand],
    ['adjacent-path-classified', hasNearbyEvidence(
      reviewOutput,
      'local-step-cache.js',
      adjacentPathPreserved,
    )],
    ['adjacent-path-not-a-finding',
      !findingRows.some((row) => row.includes('local-step-cache.js'))
      && !findingBlocks.some((block) => (
        block.includes('local-step-cache.js')
        && !hasNearbyEvidence(block, 'local-step-cache.js', adjacentPathPreserved)
      ))],
  ];
  const failed = checks.filter(([, passed]) => !passed).map(([name]) => name);
  return {
    pass: failed.length === 0,
    score: (checks.length - failed.length) / checks.length,
    reason: failed.length === 0
      ? 'the initial review rejects the documented external target lookup defect without expanding into the adjacent cache behavior'
      : `failed: ${failed.join(', ')}`,
  };
}
