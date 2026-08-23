const FINAL_DECISION_LABEL_SOURCE = '(?:Result|Final Decision|Decision|結果|最終判定|総合判定|監督判定|判定)';
const FINAL_DECISION_LABEL = new RegExp(`^${FINAL_DECISION_LABEL_SOURCE}$`, 'i');
const LABELED_FINAL_DECISION = new RegExp(
  `^${FINAL_DECISION_LABEL_SOURCE}\\s*(?::|：|is|は)\\s*(.+)$`,
  'i',
);

export function unwrapProviderOutput(output) {
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

function stripMarkdown(line) {
  return line
    .replace(/^\s*#{1,6}\s*/, '')
    .replace(/\*{1,2}|`/g, '')
    .replace(/^_{1,2}|_{1,2}$/g, '')
    .trim();
}

function isConditionalDecision(line) {
  return /\b(?:only if|if|when|unless|provided that|subject to|pending until)\b|場合(?:だけ|に限|は|には)?|(?:なければ|あれば|すれば|なら|ならば|とき|時|限り|であれば|を条件とする|が条件|条件付き|(?:成功|完了|承認|確認)後に|後に確定|まで保留)/i
    .test(line);
}

function statesConclusion(line) {
  if (/(?:結論|判定|判断)(?:づけ|付け|し).{0,50}(?:不整合|矛盾|誤り|誤って|不適切|妥当でない)|(?:不整合|矛盾|誤り|不適切).{0,50}(?:結論|判定|判断)/i.test(line)) {
    return false;
  }
  return /(?:最終的には|結論(?:として|は)?|(?:と|に)(?:判定|判断|分類)(?:する|した|します|しました)|(?:判定|判断)(?:は|が))|\b(?:finally|ultimately|is classified as|is considered|we classify|we consider|decision is|verdict is)\b/i
    .test(line);
}

function classifyDecisionLine(line) {
  const normalized = stripMarkdown(line);
  if (isConditionalDecision(normalized)) return undefined;

  const matches = [
    ['BLOCKED', /\bBLOCKED\b|外部要因.{0,30}(?:停止|保留)|外部(?:判断|承認|審査).{0,30}(?:待ち|保留)|進行不可/i],
    ['REJECT', /\bREJECT\b|差し戻し|未充足(?:の要件)?(?:あり|がある)/i],
    ['APPROVE', /\bAPPROVE\b|要件充足(?:済み|・|（|\(|$)|修正対象(?:は|が)?(?:ない|なし)|未解消(?:の問題|問題)?(?:は|が)?(?:ない|なし)/i],
  ].filter(([, pattern]) => pattern.test(normalized));

  if (matches.some(([decision]) => decision === 'BLOCKED')
    && /ただし|\bbut\b|\bhowever\b|\byet\b/i.test(normalized)) {
    return 'BLOCKED';
  }
  return matches.length === 1 ? matches[0][0] : undefined;
}

function classifyFixVerificationLine(line) {
  const normalized = stripMarkdown(line);
  if (isConditionalDecision(normalized)) return undefined;
  const asserted = normalized.replace(
    /未完了(?:の)?(?:項目|事項|問題)?(?:は|が)?(?:ない|なし|ありません)/g,
    '',
  );

  const matches = [
    ['PLAN_INVALID', /\bplan_invalid\b|計画不備/i],
    ['INCOMPLETE', /\bincomplete\b|\bREJECT\b|修正未完了|(?<!修正)未完了/i],
    ['COMPLETE', /\bverified\b|\bAPPROVE\b|\bno_issue_after_verification\b|検証(?:成功|完了)|修正完了|実装完了|^(?:成功|完了)(?:\b|[（(。.]|$)/i],
  ].filter(([, pattern]) => pattern.test(asserted));
  return matches.length === 1 ? matches[0][0] : undefined;
}

function labeledValue(line, classifier) {
  const normalized = stripMarkdown(line);
  const match = LABELED_FINAL_DECISION.exec(normalized);
  if (match === null) return undefined;
  return classifier(match[1]);
}

function tableValue(line, classifier) {
  if (!line.includes('|')) return undefined;
  const cells = line.split('|').map((cell) => stripMarkdown(cell)).filter(Boolean);
  if (cells.length !== 2 || !FINAL_DECISION_LABEL.test(cells[0])) return undefined;
  return classifier(cells[1]);
}

function collectDecisions(output, classifier) {
  const reviewOutput = unwrapProviderOutput(output);
  const lines = reviewOutput.split(/\r?\n/);
  const decisions = [];
  for (let index = 0; index < lines.length; index += 1) {
    const direct = tableValue(lines[index], classifier) ?? labeledValue(lines[index], classifier);
    if (direct !== undefined) decisions.push(direct);

    const heading = stripMarkdown(lines[index]);
    if (!FINAL_DECISION_LABEL.test(heading)) continue;
    const following = lines.slice(index + 1).find((line) => line.trim() !== '');
    const followingDecision = following === undefined ? undefined : classifier(following);
    if (followingDecision !== undefined) decisions.push(followingDecision);
  }
  const statements = reviewOutput.split(/\r?\n|(?<=[.!?。！？])\s*/u);
  for (const statement of statements) {
    if (!statesConclusion(statement)) continue;
    const decision = classifier(statement);
    if (decision !== undefined) decisions.push(decision);
  }
  return decisions;
}

function hasOnlyDecision(output, decision, classifier) {
  const decisions = collectDecisions(output, classifier);
  return decisions.length > 0 && decisions.every((candidate) => candidate === decision);
}

export function hasFinalDecision(output, decision) {
  return hasOnlyDecision(output, decision, classifyDecisionLine);
}

export function hasFixVerificationDecision(output, decision) {
  return hasOnlyDecision(output, decision, classifyFixVerificationLine);
}
