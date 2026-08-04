export function composeFindingAdjudicationInstruction(
  guidance: string | undefined,
  engineInstruction: string,
): string {
  if (guidance === undefined) {
    return engineInstruction;
  }
  return `${guidance}\n\n---\n\n${engineInstruction}`;
}
