import type { PendingSummary } from '../../infra/conversations/schema.js';
import { getLabel } from '../../shared/i18n/index.js';
import { toDisplayText } from '../tui/displayText.js';

function toDisplayBullet(item: string): string {
  return `- ${toDisplayText(item).replace(/\n/g, '\n  ')}`;
}

export function formatPendingSummary(pending: PendingSummary, lang: 'ja' | 'en'): string {
  const { summary } = pending;
  const lines = [
    getLabel('manager.summary.title', lang),
    toDisplayText(pending.repositoryDirectory),
    toDisplayText(summary.objective),
    `${getLabel('manager.summary.outOfScope', lang)}:`,
    ...summary.outOfScope.map(toDisplayBullet),
    `${getLabel('manager.summary.acceptanceCriteria', lang)}:`,
    ...summary.acceptanceCriteria.map(toDisplayBullet),
    `${getLabel('manager.summary.constraints', lang)}:`,
    ...summary.constraints.map(toDisplayBullet),
  ];
  if (summary.startBranch !== undefined) lines.push(`startBranch: ${toDisplayText(summary.startBranch)}`);
  if (summary.integrationBranch !== undefined) lines.push(`integrationBranch: ${toDisplayText(summary.integrationBranch)}`);
  return lines.join('\n');
}
