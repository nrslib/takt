import type { PendingSummary } from '../../infra/conversations/schema.js';
import { getLabel } from '../../shared/i18n/index.js';
import { toDisplayText } from '../tui/displayText.js';

function toDisplayBullet(item: string): string {
  return `- ${toDisplayText(item).replace(/\n/g, '\n  ')}`;
}

export function formatSummaryList(items: readonly string[], lang: 'ja' | 'en'): string {
  return (items.length === 0 ? [getLabel('manager.summary.none', lang)] : items).map(toDisplayBullet).join('\n');
}

export function formatPendingSummary(pending: PendingSummary, lang: 'ja' | 'en'): string {
  const { summary } = pending;
  const lines = [
    getLabel('manager.summary.title', lang),
    `${getLabel('manager.summary.repository', lang)}: ${toDisplayText(pending.repositoryDirectory)}`,
    `${getLabel('manager.summary.objective', lang)}: ${toDisplayText(summary.objective).replace(/\n/g, '\n  ')}`,
    `${getLabel('manager.summary.outOfScope', lang)}:`,
    formatSummaryList(summary.outOfScope, lang),
    `${getLabel('manager.summary.acceptanceCriteria', lang)}:`,
    formatSummaryList(summary.acceptanceCriteria, lang),
    `${getLabel('manager.summary.constraints', lang)}:`,
    formatSummaryList(summary.constraints, lang),
  ];
  if (summary.startBranch !== undefined) lines.push(`${getLabel('manager.summary.startBranch', lang)}: ${toDisplayText(summary.startBranch)}`);
  if (summary.integrationBranch !== undefined) lines.push(`${getLabel('manager.summary.integrationBranch', lang)}: ${toDisplayText(summary.integrationBranch)}`);
  return lines.join('\n');
}
