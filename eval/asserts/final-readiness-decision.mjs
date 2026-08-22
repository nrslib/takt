const FINAL_DECISION_LABEL = '(?:Result|Final Decision|Decision|結果|最終判定|判定)';
const FINAL_DECISION_VALUE = '(APPROVE|REJECT|BLOCKED)';
const FINAL_DECISION_LINE = new RegExp(
  `^\\s*(?:#{1,6}\\s*)?${FINAL_DECISION_LABEL}\\s*(?::|：|is|は)\\s*\\*{0,2}${FINAL_DECISION_VALUE}\\*{0,2}\\s*[。.]?\\s*$`,
  'i',
);
const FINAL_DECISION_TABLE_ROW = new RegExp(
  `^\\s*\\|\\s*\\*{0,2}${FINAL_DECISION_LABEL}\\*{0,2}\\s*\\|\\s*\\*{0,2}${FINAL_DECISION_VALUE}\\*{0,2}\\s*\\|\\s*$`,
  'i',
);

export function hasFinalDecision(output, decision) {
  return output.split(/\r?\n/).some((line) => {
    const match = FINAL_DECISION_LINE.exec(line) ?? FINAL_DECISION_TABLE_ROW.exec(line);
    return match?.[1]?.toUpperCase() === decision;
  });
}
