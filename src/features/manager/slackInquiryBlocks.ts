import type { Button, KnownBlock, SectionBlock } from '@slack/types';
import type { GoalAnswerInput } from '../../infra/goals/schema.js';
import { getLabel } from '../../shared/i18n/index.js';
import type { PendingQuestion } from './inquiryAnswer.js';

export const SLACK_INQUIRY_ACTION = 'takt_inquiry_answer';
export type SlackInquiryAction = { kind: 'answer'; answer: GoalAnswerInput };

const SECTION_TEXT_LIMIT = 2900;

function splitText(text: string): string[] {
  const chunks: string[] = [];
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(offset + SECTION_TEXT_LIMIT, text.length);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
    chunks.push(text.slice(offset, end));
    offset = end;
  }
  return chunks;
}

export function buildSlackInquiry(target: PendingQuestion, language: 'ja' | 'en', blockId: string) {
  const actions = new Map<string, SlackInquiryAction>();
  const button = (key: string, label: string, action: SlackInquiryAction): Button => {
    actions.set(key, action);
    return { type: 'button', text: { type: 'plain_text', text: Array.from(label).slice(0, 75).join('') },
      action_id: `${SLACK_INQUIRY_ACTION}_${key}`, value: key };
  };
  const contents: KnownBlock[] = [];
  const add = (blocks: KnownBlock[]): void => {
    contents.push(...blocks);
  };
  const section = (text: string): SectionBlock => ({ type: 'section', text: { type: 'plain_text', text } });
  const question = target.question;
  for (const text of splitText(question.body)) add([section(text)]);
  const buttons: Button[] = [];
  if (question.kind === 'operation_request') {
    for (const report of ['completed', 'unable'] as const) {
      buttons.push(button(`report_${report}`, getLabel(`manager.answerChoices.${report}`, language), { kind: 'answer', answer: { report } }));
    }
  } else if (question.kind !== 'approval') {
    for (const [index, option] of (question.options ?? []).entries()) {
      const chunks = splitText(option);
      for (const [part, text] of chunks.entries()) {
        const blocks: KnownBlock[] = [section(`${index + 1}. ${text}`)];
        if (part === chunks.length - 1) blocks.push({ type: 'actions', elements: [
          button(`option_${index}`, `${index + 1}. ${option}`, { kind: 'answer', answer: { text: option } }),
        ] });
        add(blocks);
      }
    }
  }
  for (let offset = 0; offset < buttons.length; offset += 5) add([{ type: 'actions', elements: buttons.slice(offset, offset + 5) }]);
  const hint = getLabel('manager.slack.replyHint', language);
  const blocks: KnownBlock[] = [...contents, { type: 'context', block_id: blockId, elements: [{ type: 'plain_text', text: hint }] }];
  const text = [...contents.flatMap((block) => block.type === 'section' && block.text !== undefined ? [block.text.text] : []), hint].join('\n');
  return { text, blocks, actions };
}
