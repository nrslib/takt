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

function hasNearbyEvidence(output, anchor, evidence) {
  let index = output.indexOf(anchor);
  while (index >= 0) {
    if (evidence.test(output.slice(Math.max(0, index - 500), index + 700))) return true;
    index = output.indexOf(anchor, index + anchor.length);
  }
  return false;
}

function hasRejectVerdict(output) {
  return /(?:結果|判定|Result|Verdict)\s*:\s*(?:\*{1,2}|_{1,2}|`)?REJECT/i.test(output)
    || /^(?:#+\s*)?(?:[^\n（(]{0,40}[（(])?(?:\*{1,2}|_{1,2}|`)?REJECT(?:\*{1,2}|_{1,2}|`)?(?:[）)])?(?:\s+[—–-].*)?\s*$/im.test(output);
}

function hasConnectedFamilyEvidence(output) {
  const routeStages = [
    /(docs\/configuration\.md|authoritative|owner|正本)/i,
    /(config\/runtime\.json|runtime config|config\.stepTargets|stepTargets|設定)/i,
    /(resolveExecutionTarget|execution-target\.js|executeStep|execution|terminal(?:\s+string)?|実行経路|実行用|実行結果|terminal\s*文字列)/i,
    /(resolvePreviewTarget|preview-target\.js|previewStep|preview|プレビュー|表示)/i,
    /(e2e|behavior test|回帰テスト|振る舞いテスト)/i,
  ];
  return routeStages.every((stage) => stage.test(output));
}

export default function assertInitialReviewExternalIdentityWiring(output) {
  const reviewOutput = unwrapProviderOutput(output);
  const findingRows = extractFindingRows(reviewOutput);
  const canonicalKey = /sample-flow\s*\/\s*execute/i;
  const defaultFallback = /default(?:-runner| target| fallback)|デフォルト(?:ターゲット|へ|に)|フォールバック/i;
  const falsePositiveEvidence = /(self[- ]consistent|false positive|green|pass(?:es|ed|ing)?|成功|通(?:る|って|過)|偽陽性|自己整合)/i;
  const wrongSharedRepresentation = /(raw|bare|short(?:ened)?|step\.name|execute[^/]|短縮|生の|裸の).{0,120}(?:implementation|resolver|lookup|config|fixture|test|実装|設定|テスト)|(?:implementation|resolver|lookup|config|fixture|test|実装|設定|テスト).{0,120}(?:raw|bare|short(?:ened)?|step\.name|短縮|生の|裸の)/is;
  const canonicalTestDemand = /(add|change|replace|require|assert|cover|update|追加|変更|置換|要求|検証|更新).{0,240}(?:test|e2e|テスト).{0,240}(?:canonical|sample-flow\s*\/\s*execute)|(?:test|e2e|テスト).{0,240}(?:add|change|replace|require|assert|cover|update|追加|変更|置換|要求|検証|更新).{0,240}(?:canonical|sample-flow\s*\/\s*execute)|(?:修正方針|fix suggestion|remediation).{0,500}canonical.{0,300}(?:期待値|case|ケース|test|e2e)/is;
  const checks = [
    ['reject-verdict', hasRejectVerdict(reviewOutput)],
    ['single-family-complete', hasConnectedFamilyEvidence(reviewOutput)],
    ['canonical-key-derived', canonicalKey.test(reviewOutput)],
    ['canonical-input-falls-to-default', canonicalKey.test(reviewOutput)
      && hasNearbyEvidence(reviewOutput, 'sample-flow/execute', defaultFallback)],
    ['false-green-explained', falsePositiveEvidence.test(reviewOutput)
      && wrongSharedRepresentation.test(reviewOutput)
      && /e2e/i.test(reviewOutput)],
    ['canonical-behavior-test-required', canonicalTestDemand.test(reviewOutput)],
    ['adjacent-path-classified', hasNearbyEvidence(
      reviewOutput,
      'src/local-step-cache.js',
      /(outside|preserved|adjacent|clean|no issue|out of scope|対象外|保持|隣接|問題なし|変更不要)/i,
    )],
    ['adjacent-path-not-a-finding', !findingRows.some((row) => row.includes('src/local-step-cache.js'))],
  ];
  const failed = checks.filter(([, passed]) => !passed).map(([name]) => name);
  return {
    pass: failed.length === 0,
    score: (checks.length - failed.length) / checks.length,
    reason: failed.length === 0
      ? 'the initial review rejects the canonical external identity wiring defect without expanding into the adjacent cache contract'
      : `failed: ${failed.join(', ')}`,
  };
}
