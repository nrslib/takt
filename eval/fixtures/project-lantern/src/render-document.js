export function renderDocument(input, template) {
  return {
    path: template.replace('{document_id}', input.document_id),
    content: `# ${input.document_id}\n${input.items.map((item) => `- ${item}`).join('\n')}`,
  };
}
