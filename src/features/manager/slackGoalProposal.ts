import type { KnownBlock } from '@slack/types';
import type { PendingSummary } from '../../infra/conversations/schema.js';
import { getLabel } from '../../shared/i18n/index.js';
import { formatSummaryList, formatGoalSpecifications } from './summaryDisplay.js';

export const SLACK_GOAL_APPROVE = 'takt_goal_approve';
export const SLACK_GOAL_DISMISS = 'takt_goal_dismiss';

export function parseSlackGoalProposal(value: string): { conversationId: string; revision: number } | undefined {
  let decoded: unknown;
  try { decoded = JSON.parse(value) as unknown; } catch { return undefined; }
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) return undefined;
  const fields = decoded as Record<string, unknown>;
  if (Object.keys(fields).length !== 2 || typeof fields.conversationId !== 'string' || !Number.isSafeInteger(fields.revision)
    || (fields.revision as number) < 0) return undefined;
  return { conversationId: fields.conversationId, revision: fields.revision as number };
}

export function buildSlackGoalProposal(conversationId: string, pending: PendingSummary, language: 'ja' | 'en'): { text: string; blocks: KnownBlock[] }[] {
  const summary = pending.summary;
  const sections = [
    ...(pending.managerId === undefined ? [] : [`${getLabel('manager.summary.manager', language)}: ${pending.managerId}`]),
    `${getLabel('manager.summary.repository', language)}: ${pending.repositoryDirectory}`,
    `${getLabel('manager.summary.objective', language)}:\n${summary.objective}`,
    `${getLabel('manager.summary.outOfScope', language)}:\n${formatSummaryList(summary.outOfScope, language)}`,
    `${getLabel('manager.summary.acceptanceCriteria', language)}:\n${formatSummaryList(summary.acceptanceCriteria, language)}`,
    `${getLabel('manager.summary.constraints', language)}:\n${formatSummaryList(summary.constraints, language)}`,
    ...formatGoalSpecifications(summary.specifications),
  ];
  if (summary.startBranch !== undefined) sections.push(`${getLabel('manager.summary.startBranch', language)}: ${summary.startBranch}`);
  if (summary.integrationBranch !== undefined) sections.push(`${getLabel('manager.summary.integrationBranch', language)}: ${summary.integrationBranch}`);
  const messages: { text: string; blocks: KnownBlock[] }[] = [];
  let fragments: string[] = [];
  const flush = () => {
    messages.push({ text: fragments.join('\n'), blocks: fragments.map((text) => ({ type: 'section', text: { type: 'plain_text', text } })) });
    fragments = [];
  };
  for (const section of sections) {
    for (let offset = 0; offset < section.length;) {
      let end = Math.min(offset + 2900, section.length);
      const last = section.charCodeAt(end - 1);
      if (end < section.length && last >= 0xd800 && last <= 0xdbff) end--;
      fragments.push(section.slice(offset, end));
      if (fragments.length === 10) flush();
      offset = end;
    }
  }
  flush();
  const final = messages.at(-1)!;
  if (final.text.length === 0) final.text = getLabel('manager.makeGoalDescription', language);
  const value = JSON.stringify({ conversationId, revision: pending.revision });
  final.blocks.push({ type: 'actions', elements: [
    { type: 'button', action_id: SLACK_GOAL_APPROVE, text: { type: 'plain_text', text: getLabel('manager.slackGoalApprove', language) }, value },
    { type: 'button', action_id: SLACK_GOAL_DISMISS, text: { type: 'plain_text', text: getLabel('manager.slackGoalDismiss', language) }, value },
  ] });
  return messages;
}
