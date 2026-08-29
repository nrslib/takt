export function renderDocument(input, labelTemplate) {
  return {
    label: labelTemplate.replace('{document_id}', input.document_id),
    content: `# ${input.document_id}\n${input.items.map((item) => `- ${item}`).join('\n')}`,
  };
}
