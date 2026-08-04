export function composeFindingManagerInstruction(input: {
  baseInstruction: string;
  policyContents?: readonly string[];
  knowledgeContents?: readonly string[];
}): string {
  if (input.policyContents?.length === 0 || input.knowledgeContents?.length === 0) {
    throw new Error('Finding Manager policy/knowledge additions must not be empty');
  }
  if (input.policyContents === undefined && input.knowledgeContents === undefined) {
    return input.baseInstruction;
  }
  const sections = [
    input.knowledgeContents === undefined
      ? undefined
      : ['## Knowledge additions', input.knowledgeContents.join('\n---\n')].join('\n'),
    input.policyContents === undefined
      ? undefined
      : ['## Policy additions', input.policyContents.join('\n---\n')].join('\n'),
  ].filter((section): section is string => section !== undefined);
  return `${sections.join('\n\n')}\n\n${input.baseInstruction}`;
}
