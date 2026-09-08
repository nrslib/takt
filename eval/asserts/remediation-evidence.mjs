export default function assertRemediationResult(output, context) {
  const expected = context.vars.expected_result;
  const matches = [...output.matchAll(/^## (?:結果|Result):\s*(verified|incomplete|plan_invalid)\s*$/gm)];
  const pass = matches.length === 1 && matches[0][1] === expected;
  return {
    pass,
    score: pass ? 1 : 0,
    reason: pass
      ? `Verified classification: ${expected}`
      : `Expected exactly one ${expected} result; found ${matches.map(match => match[1]).join(', ') || 'none'}`,
  };
}
