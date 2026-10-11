import { describe, expect, it } from 'vitest';
import { formatInlineUtteranceSection } from '../features/interactive/promptSections.js';

describe('inline utterance templates', () => {
  it.each([
    {
      lang: 'en' as const,
      artifactInstruction: 'Produce the artifact in the format specified for this entry point.',
      integrationInstruction: 'Keep the original task when integrating a supplement',
      requeueInstruction: 'Do not generate an instruction document.',
    },
    {
      lang: 'ja' as const,
      artifactInstruction: '成果物はこの経路で指定された形式で作成してください。',
      integrationInstruction: '補足を反映するときは元のタスクを保持し',
      requeueInstruction: '指示書は生成しないでください。',
    },
  ])('omits artifact instructions for requeue in $lang', ({ lang, artifactInstruction, integrationInstruction, requeueInstruction }) => {
    const requeueSection = formatInlineUtteranceSection(lang, 'requeue', 'Resume the selected task.');
    const retrySection = formatInlineUtteranceSection(lang, 'retry', 'Revise the selected task.');

    expect(requeueSection).not.toContain(artifactInstruction);
    expect(requeueSection).not.toContain(integrationInstruction);
    expect(requeueSection).toContain(requeueInstruction);
    expect(retrySection).toContain(artifactInstruction);
    expect(retrySection).toContain(integrationInstruction);
    expect(retrySection).not.toContain(requeueInstruction);
  });
});
