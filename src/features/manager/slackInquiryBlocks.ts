import type { Button, KnownBlock, ModalView, SectionBlock } from '@slack/types';
import type { GoalAnswerInput } from '../../infra/goals/schema.js';
import { getLabel } from '../../shared/i18n/index.js';
import { approvalScopeChoices, type ApprovalScopeChoice, type PendingQuestion } from './inquiryAnswer.js';
import type { ManagerAssignment } from './startupResolution.js';

export const SLACK_INQUIRY_ACTION = 'takt_inquiry_answer';
export const SLACK_PERMISSION_CALLBACK = 'takt_inquiry_permission';
export const SLACK_PERMISSION_BLOCK = 'permission';
export const SLACK_PERMISSION_INPUT = 'sentence';
export type SlackInquiryAction =
  | { kind: 'answer'; answer: GoalAnswerInput }
  | { kind: 'permission'; choice: ApprovalScopeChoice };

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

export function buildSlackInquiry(target: PendingQuestion, assignment: ManagerAssignment, language: 'ja' | 'en', blockId: string) {
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
  if (question.kind === 'approval') {
    for (const choice of approvalScopeChoices(target, assignment)) {
      buttons.push(button(`allow_${choice.value}`, getLabel(`manager.answerChoices.${choice.label}`, language), choice.permission === undefined
        ? { kind: 'answer', answer: { decision: 'allow', scope: choice.value } } : { kind: 'permission', choice }));
    }
    buttons.push(button('deny', getLabel('manager.answerChoices.deny', language), { kind: 'answer', answer: { decision: 'deny' } }));
  } else if (question.kind === 'operation_request') {
    for (const report of ['completed', 'unable'] as const) {
      buttons.push(button(`report_${report}`, getLabel(`manager.answerChoices.${report}`, language), { kind: 'answer', answer: { report } }));
    }
  } else {
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

export function buildSlackPermissionModal(proposal: string, metadata: string, language: 'ja' | 'en'): ModalView {
  return { type: 'modal', callback_id: SLACK_PERMISSION_CALLBACK, private_metadata: metadata, notify_on_close: true,
    title: { type: 'plain_text', text: getLabel('manager.slack.permissionTitle', language) },
    submit: { type: 'plain_text', text: getLabel('manager.slack.confirm', language) },
    close: { type: 'plain_text', text: getLabel('manager.slack.cancel', language) },
    blocks: [{ type: 'input', block_id: SLACK_PERMISSION_BLOCK,
      label: { type: 'plain_text', text: getLabel('manager.slack.permissionSentence', language) },
      element: { type: 'plain_text_input', action_id: SLACK_PERMISSION_INPUT, initial_value: proposal } }] };
}
