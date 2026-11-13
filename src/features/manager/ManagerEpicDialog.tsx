import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import type { EpicSnapshot } from '../../infra/epics/projection.js';
import { getLabel } from '../../shared/i18n/index.js';
import { sanitizeSensitiveText } from '../../shared/utils/sensitiveText.js';
import { toSingleLineText } from '../tui/displayText.js';
import { layoutQuestionBody } from './questionBodyLayout.js';
import { snapshotItemKey } from './snapshotChanges.js';
import type { EpicNavigation } from './useManagerEpics.js';

type Language = 'en' | 'ja';
const safeText = (value: string): string => sanitizeSensitiveText(toSingleLineText(value));

function progressText(item: EpicSnapshot, lang: Language): string {
  const known = item.epic.members.flatMap((member) => {
    const progress = item.memberProgress.find((entry) => entry.repositoryDirectory === member.repositoryDirectory && entry.goalId === member.goalId);
    return progress === undefined ? [] : [progress];
  });
  const completed = known.filter((member) => member.status === 'completed' && member.executionStatus !== 'aborted').length;
  const unknown = item.epic.members.length - known.length;
  return `${completed}/${item.epic.members.length}` + (unknown === 0 ? '' : ` (${getLabel('manager.epics.unknownCount', lang, { count: String(unknown) })})`);
}

function evidenceText(item: EpicSnapshot, lang: Language): string {
  const evidence = item.epic.currentEvidence;
  return evidence === undefined ? getLabel('manager.epics.none', lang)
    : `${evidence.id} — ${getLabel(`manager.epics.runStates.${evidence.status}`, lang)}`;
}

function verificationSummary(item: EpicSnapshot, lang: Language): string {
  const running = item.epic.runningVerification;
  const latest = item.epic.verificationRuns.at(-1);
  const result = running !== undefined ? getLabel('manager.epics.recovery', lang)
    : latest === undefined ? getLabel('manager.epics.unverified', lang)
    : getLabel(`manager.epics.runStates.${latest.status}`, lang);
  const reason = item.epic.verificationRuns.filter((run) => run.invalidationReason !== undefined).at(-1)?.invalidationReason;
  return `${result} | ${getLabel('manager.epics.currentEvidence', lang)}: ${evidenceText(item, lang)}`
    + (reason === undefined ? '' : ` | ${safeText(reason)}`);
}

export function formatManagerEpicDetail(item: EpicSnapshot, lang: Language, width: number): string[] {
  const { epic } = item;
  const label = (key: string): string => getLabel(`manager.epics.${key}`, lang);
  const lines = [safeText(epic.objective), `ID: ${epic.id}`, `${label('status')}: ${getLabel(`manager.epics.states.${epic.status}`, lang)}`,
    `${label('revision')}: ${epic.revision}`, `${label('progress')}: ${progressText(item, lang)}`,
    `${label('currentEvidence')}: ${evidenceText(item, lang)}`, label('members')];
  for (const member of epic.members) {
    const progress = item.memberProgress.find((entry) => entry.repositoryDirectory === member.repositoryDirectory && entry.goalId === member.goalId);
    const target = epic.targets.find((entry) => entry.repositoryDirectory === member.repositoryDirectory && entry.goalId === member.goalId);
    lines.push(safeText(member.repositoryDirectory), `  ${member.goalId}`,
      `  ${progress === undefined ? label('unknown') : `${safeText(progress.status)} / ${safeText(progress.executionStatus)}`}`,
      `  targetSha: ${target === undefined ? label('unfixed') : target.targetSha}`);
  }
  lines.push(label('verificationHistory'));
  if (epic.verificationRuns.length === 0) lines.push(label('unverified'));
  for (const run of epic.verificationRuns) {
    const recovering = item.recovery.some((entry) => entry.id === run.id);
    lines.push(`${run.id} — ${getLabel(`manager.epics.runStates.${run.status}`, lang)}${recovering ? ` / ${label('recovery')}` : ''}`);
    lines.push(`  ${label('revision')}: ${run.revision} / ${label('procedureVersion')}: ${run.procedureVersion}`, `  ${run.startedAt}`);
    if (run.invalidationReason !== undefined) lines.push(`  ${label('invalidationReason')}: ${safeText(run.invalidationReason)}`);
    if (run.result !== undefined) {
      const result = run.result;
      lines.push(`  ${label('result')}: ${getLabel(`manager.epics.runStates.${result.outcome}`, lang)} / ${result.completedAt}`,
        `  ${label('environment')}: ${safeText(result.environment.name)} — ${safeText(result.environment.description)}`);
      for (const target of run.targets) lines.push(`  ${safeText(target.repositoryDirectory)} / ${target.goalId} / ${target.targetSha}`);
      for (const entry of result.acceptanceResults) lines.push(`  ${safeText(entry.criterionId)}: ${safeText(entry.outcome)}`);
      for (const artifact of result.artifacts) lines.push(`  ${label('artifact')}: ${safeText(artifact.reference)}`);
      lines.push(`  ${label('workspace')}: ${safeText(result.workspace.directory)}`);
      for (const reference of result.logReferences ?? []) lines.push(`  ${label('log')}: ${safeText(reference)}`);
      if (result.terraform !== undefined) lines.push(`  Terraform: ${result.terraform.phase} / ${result.terraform.applyStatus}`);
    }
  }
  lines.push(label('criteria'), ...epic.acceptanceCriteria.map((criterion) => `${safeText(criterion.id)}: ${safeText(criterion.description)}`),
    `${label('procedureVersion')}: ${epic.verificationProcedure.version}`, ...epic.verificationProcedure.steps.map(safeText),
    label('changes'), ...epic.changes.map((change) => `${change.recordedAt} — ${safeText(change.reason)}`));
  return lines.flatMap((line) => layoutQuestionBody(line, width));
}

export function ManagerEpicDialog({ navigation, epics, index, detailLines, pageRows, titleLines, hintLines, lang, workspace }: {
  navigation: EpicNavigation; epics: readonly EpicSnapshot[]; index: number; detailLines: readonly string[];
  pageRows: number; lang: Language; workspace: boolean;
  titleLines: readonly string[]; hintLines: readonly string[];
}): ReactElement {
  const pageSize = Math.max(1, Math.min(10, Math.floor(pageRows / 2)));
  const start = Math.floor(index / pageSize) * pageSize;
  const offset = navigation.kind === 'detail' ? Math.min(navigation.offset, Math.max(0, detailLines.length - pageRows)) : 0;
  return <Box borderStyle="round" flexDirection="column">
    <Text bold wrap="truncate-end">{titleLines.join('\n')}</Text>
    {!workspace ? <Text>{getLabel('manager.epics.workspaceRequired', lang)}</Text>
      : navigation.kind === 'detail' ? <Text>{detailLines.length === 0 ? getLabel('manager.epics.unavailable', lang)
        : detailLines.slice(offset, offset + pageRows).join('\n')}</Text>
      : epics.length === 0 ? <Text>{getLabel('manager.epics.empty', lang)}</Text>
      : epics.slice(start, start + pageSize).map((item, position) => <Box key={snapshotItemKey(item)} flexDirection="column">
        <Text inverse={start + position === index} wrap="truncate-end">{safeText(item.epic.objective)} — {getLabel(`manager.epics.states.${item.epic.status}`, lang)} — {progressText(item, lang)}</Text>
        <Text wrap="truncate-end">{verificationSummary(item, lang)}</Text>
      </Box>)}
    <Text dimColor wrap="truncate-end">{hintLines.join('\n')}</Text>
  </Box>;
}
