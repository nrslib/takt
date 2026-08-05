import type { ResolvedFacetContent } from '../../models/workflow-types.js';

export function composeFindingManagerInstruction(input: {
  baseInstruction: string;
  policyContents?: readonly ResolvedFacetContent[];
  knowledgeContents?: readonly ResolvedFacetContent[];
}): string {
  if ((input.policyContents !== undefined && input.policyContents.length === 0)
    || (input.knowledgeContents !== undefined && input.knowledgeContents.length === 0)) {
    throw new Error('Finding Manager policy/knowledge additions must not be empty');
  }
  if (input.policyContents === undefined && input.knowledgeContents === undefined) {
    return input.baseInstruction;
  }
  const policyStrings = input.policyContents?.map((c) => c.content);
  const knowledgeStrings = input.knowledgeContents?.map((c) => c.content);
  const sections = [
    knowledgeStrings === undefined
      ? undefined
      : ['## Knowledge additions', knowledgeStrings.join('\n---\n')].join('\n'),
    policyStrings === undefined
      ? undefined
      : ['## Policy additions', policyStrings.join('\n---\n')].join('\n'),
  ].filter((section): section is string => section !== undefined);
  return `${sections.join('\n\n')}\n\n${input.baseInstruction}`;
}
