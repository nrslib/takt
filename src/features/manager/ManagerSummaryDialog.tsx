import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import { toDisplayText } from '../tui/displayText.js';
import type { PendingManagerSummary } from './conversationSession.js';

function toDisplayBullet(item: string): string {
  return `- ${toDisplayText(item).replace(/\n/g, '\n  ')}`;
}

export function ManagerSummaryDialog({ pending, approve, ja }: {
  pending: PendingManagerSummary; approve: boolean; ja: boolean;
}): ReactElement {
  return (
    <Box borderStyle="round" flexDirection="column">
      <Text bold>{ja ? '登録する要約' : 'Summary to register'}</Text>
      {pending.repositoryDirectory !== undefined && <Text>{toDisplayText(pending.repositoryDirectory)}</Text>}
      <Text>{toDisplayText(pending.summary.objective)}</Text>
      <Text>{`${ja ? '範囲外' : 'Out of scope'}:`}</Text>
      {pending.summary.outOfScope.map((item, index) => <Text key={index}>{toDisplayBullet(item)}</Text>)}
      <Text>{`${ja ? '受け入れ条件' : 'Acceptance criteria'}:`}</Text>
      {pending.summary.acceptanceCriteria.map((item, index) => <Text key={index}>{toDisplayBullet(item)}</Text>)}
      <Text>{`${ja ? '作業の制約' : 'Work constraints'}:`}</Text>
      {pending.summary.constraints.map((item, index) => <Text key={index}>{toDisplayBullet(item)}</Text>)}
      {pending.summary.startBranch !== undefined && <Text>{`startBranch: ${toDisplayText(pending.summary.startBranch)}`}</Text>}
      {pending.summary.integrationBranch !== undefined && <Text>{`integrationBranch: ${toDisplayText(pending.summary.integrationBranch)}`}</Text>}
      <Text inverse={approve}>{ja ? '登録を承認' : 'Approve registration'}</Text>
      <Text inverse={!approve}>{ja ? '会話を続ける' : 'Continue conversation'}</Text>
      <Text dimColor>{ja ? '↑ 承認 / ↓ 続行 / Enter 決定' : '↑ Approve / ↓ Continue / Enter Select'}</Text>
    </Box>
  );
}
