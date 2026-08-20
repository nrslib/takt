import { describe, expect, it } from 'vitest';
import { loadTemplate } from '../shared/prompts/index.js';

describe.each(['en', 'ja'] as const)('order revision %s prompt template', (lang) => {
  it('keeps a canonical order code fence inside the delimited section', () => {
    const canonicalOrderContent = [
      '# Existing order',
      '',
      '```markdown',
      'Keep this fenced requirement.',
      '```',
    ].join('\n');

    const prompt = loadTemplate('score_order_revision_system_prompt', lang, {
      canonicalOrderContent,
      conversation: 'User: add a requirement',
      sourceContext: '',
      userNote: '',
      hasWorkflowPreview: false,
      workflowStructure: '',
      stepDetails: '',
    });

    expect(prompt).toContain([
      '--- BEGIN CANONICAL ORDER.MD ---',
      canonicalOrderContent,
      '--- END CANONICAL ORDER.MD ---',
    ].join('\n'));
    expect(prompt).not.toContain([
      '```markdown',
      canonicalOrderContent,
      '```',
    ].join('\n'));
  });
});
