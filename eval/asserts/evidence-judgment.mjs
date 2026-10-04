export default function assertEvidenceJudgment(output, context) {
  const matches = [...output.matchAll(/^DECISION:[ \t]*(retain|repair|verify|investigate)[ \t]*$/gm)];
  const pass = matches.length === 1 && matches[0][1] === context.vars.expected_decision;
  return { pass, score: pass ? 1 : 0, reason: `Expected one ${context.vars.expected_decision} decision; found ${matches.map(match => match[1]).join(', ') || 'none'}` };
}
