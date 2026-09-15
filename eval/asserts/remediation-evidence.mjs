export default function assertRemediationResult(output, context) {
  const expected = context.vars.expected_result;
  const matches = [...output.matchAll(/^## (?:結果|Result):[ \t]*(verified|incomplete|plan_invalid)[ \t]*$/gm)];
  const sections = [...output.matchAll(/^## (?:任意の実行記録がない未確認範囲（判定非ブロッキング）|Unverified Scope Without Optional Execution Records \(Non-blocking\))[ \t]*\r?\n([\s\S]*?)(?=^#{1,2} |$(?![\s\S]))/gm)];
  const hasUnknownSection = sections.length === 1 && sections[0][1].trim().length > 0;
  const pass = matches.length === 1 && matches[0][1] === expected && hasUnknownSection;
  return {
    pass,
    score: pass ? 1 : 0,
    reason: pass
      ? `Verified classification and non-blocking unknown section: ${expected}`
      : `Expected exactly one ${expected} result and one nonempty non-blocking unknown section; found results: ${matches.map(match => match[1]).join(', ') || 'none'}, valid section: ${hasUnknownSection}`,
  };
}
