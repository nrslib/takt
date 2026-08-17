const FINAL_DECISION_HEADING = /(?:^|\n)\s*#{1,6}\s*(?:Result|Final Decision|Decision|結果|最終判定|判定)\s*[:：]\s*(APPROVE|REJECT|BLOCKED)\b/gim;

export function hasFinalDecision(output, decision) {
  return [...output.matchAll(FINAL_DECISION_HEADING)]
    .some((match) => match[1].toUpperCase() === decision);
}
