import type { GoalQuestion } from '../../infra/goals/schema.js';
import type { SlackClient, SlackDeliveryResult } from '../../infra/slack/client.js';
import { SlackInquiryBindings, slackInquiryKey } from '../../infra/slack/inquiryBindings.js';
import { escapeSlackMentions } from '../../shared/utils/slackText.js';
import type { QuestionTarget } from './conversationPort.js';
import { buildSlackInquiry } from './slackInquiryBlocks.js';

export function createSlackInquiryDelivery(options: {
  bindings: SlackInquiryBindings; channelId: string; client: SlackClient; language: 'ja' | 'en';
}) {
  const active = new Map<string, Promise<SlackDeliveryResult>>();
  const deliver = (target: QuestionTarget, question: GoalQuestion, isAvailable: () => boolean | Promise<boolean>): Promise<SlackDeliveryResult> => {
    const key = slackInquiryKey(target, question.id);
    const previous = active.get(key) ?? Promise.resolve({ kind: 'delivered' as const });
    const send = async (): Promise<SlackDeliveryResult> => {
      const binding = await options.bindings.question(options.channelId, target, question.id);
      if (!await isAvailable()) return { kind: 'unavailable', reason: 'Inquiry unavailable' };
      const pending = question.status === 'pending' && question.recipient === 'human';
      if (binding === undefined && !pending) return { kind: 'delivered' };
      const state = question.status === 'pending' ? question.recipient : question.status;
      const message = pending ? buildSlackInquiry(target.goalId === null ? { ...target, question } : { ...target, question, objective: '' }, options.language, key)
        : { text: `${question.body}\n${options.language === 'ja' ? '現在の宛先・状態' : 'Current recipient or status'}: ${state}`, blocks: [] };
      if (binding !== undefined) return options.client.updateMessage({ channelId: options.channelId, parentTs: binding.parentTs }, escapeSlackMentions(message.text), message.blocks);
      const result = await options.client.postMessage(options.channelId, escapeSlackMentions(message.text), message.blocks);
      if (result.kind === 'delivered') await options.bindings.save({ channelId: options.channelId, parentTs: result.parentTs, target, questionId: question.id });
      return result;
    };
    const sending = previous.then(send, send);
    active.set(key, sending);
    void sending.finally(() => { if (active.get(key) === sending) active.delete(key); }).catch(() => {});
    return sending;
  };
  return { deliver, async close() { await Promise.allSettled([...active.values()]); } };
}
