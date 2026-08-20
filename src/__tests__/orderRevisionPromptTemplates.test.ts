import { describe, expect, it } from 'vitest';
import { buildOrderRevisionPrompt } from '../features/interactive/orderRevisionMode.js';

describe.each(['en', 'ja'] as const)('order revision %s prompt template', (lang) => {
  it('keeps canonical content inside a nonce-delimited section', () => {
    const canonicalOrderContent = [
      '# Existing order',
      '',
      '--- BEGIN CANONICAL ORDER.MD ---',
      'Keep this marker in the authored order.',
      '--- END CANONICAL ORDER.MD ---',
    ].join('\n');

    const prompt = buildOrderRevisionPrompt({
      history: [{ role: 'user', content: 'add a requirement' }],
      hasSession: false,
      lang,
      noTranscriptNote: '',
      conversationLabel: 'Conversation',
      gherkin: false,
      userNote: '',
    }, canonicalOrderContent);

    const markerMatch = prompt.match(/--- BEGIN CANONICAL ORDER\.MD ([0-9a-f-]+) ---/);
    expect(markerMatch).not.toBeNull();
    const nonce = markerMatch?.[1];
    if (!nonce) {
      throw new Error('Expected a nonce in the canonical order delimiter.');
    }
    const beginMarker = `--- BEGIN CANONICAL ORDER.MD ${nonce} ---`;
    const endMarker = `--- END CANONICAL ORDER.MD ${nonce} ---`;
    const beginIndex = prompt.indexOf(beginMarker);
    const endIndex = prompt.indexOf(endMarker);

    expect(prompt.match(/--- BEGIN CANONICAL ORDER\.MD ---/g)).toHaveLength(1);
    expect(prompt.match(/--- END CANONICAL ORDER\.MD ---/g)).toHaveLength(1);
    expect(prompt.slice(beginIndex + beginMarker.length + 1, endIndex).trimEnd()).toBe(canonicalOrderContent);
    expect(prompt).toContain(endMarker);
  });
});
