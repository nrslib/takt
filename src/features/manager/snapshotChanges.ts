import { createHash } from 'node:crypto';
import type { SnapshotItem, SnapshotRead, SnapshotValue } from './conversationPort.js';
import { compareInquiries } from '../../infra/goals/inquiry-order.js';

export type SnapshotDisplayItem = Exclude<SnapshotValue, { kind: 'state' }>;

export function orderSnapshotItems(items: ReadonlyMap<string, SnapshotDisplayItem>): SnapshotDisplayItem[] {
  const assignment = items.get('assignment');
  const repositories = new Map(assignment?.kind === 'assignment'
    ? assignment.assignment.repositoryDirectories.map((directory, index) => [directory, index]) : []);
  const groups = { assignment: 0, goal: 1, epic: 2, inquiry: 3, display_event: 4, user_message: 5, tool_history: 5, turn_result: 5 };
  const ordered = [...items.values()].sort((left, right) => {
    if (left.kind === 'epic' && right.kind === 'epic') return left.epic.workspaceId.localeCompare(right.epic.workspaceId) || left.epic.id.localeCompare(right.epic.id);
    if (left.kind === 'goal' && right.kind === 'goal') {
      // 未完了の差分では、assignmentから外れたリポジトリの旧項目も保持する。
      return (repositories.get(left.goal.repositoryDirectory) ?? Infinity) - (repositories.get(right.goal.repositoryDirectory) ?? Infinity)
        || left.goal.id.localeCompare(right.goal.id);
    }
    if (left.kind === 'inquiry' && right.kind === 'inquiry') {
      return compareInquiries({ ...left.inquiry.target, question: left.inquiry.question },
        { ...right.inquiry.target, question: right.inquiry.question });
    }
    return groups[left.kind] - groups[right.kind];
  });
  // Background turns and generation resets must not reorder the persisted tool log.
  const messages = ordered.filter((item) => item.kind === 'user_message').sort((left, right) => left.acceptedSequence - right.acceptedSequence);
  const conversation: SnapshotDisplayItem[] = [];
  let next = 0;
  for (const item of ordered) {
    if (item.kind !== 'tool_history') continue;
    const sequence = item.acceptedSequence;
    if (sequence !== undefined) {
      while (next < messages.length && messages[next]!.acceptedSequence <= sequence) conversation.push(messages[next++]!);
    }
    conversation.push(item);
  }
  while (next < messages.length) conversation.push(messages[next++]!);
  return [...ordered.filter((item) => item.kind !== 'tool_history' && item.kind !== 'user_message' && item.kind !== 'turn_result'),
    ...placeTurnResults(conversation, ordered)];
}

/** 結果はそのターンの発言とツールの後に置く。どちらもないターンは、受付順で後の発言より前に置く。 */
function placeTurnResults(conversation: readonly SnapshotDisplayItem[], ordered: readonly SnapshotDisplayItem[]): SnapshotDisplayItem[] {
  const results = new Map(ordered.flatMap((item) => item.kind === 'turn_result' ? [[item.operationId, item] as const] : []));
  const lastTurnItems = new Map<string, number>();
  conversation.forEach((item, index) => {
    const operationId = turnOperationId(item);
    if (operationId !== undefined) lastTurnItems.set(operationId, index);
  });
  const unowned = [...results.values()].filter((result) => !lastTurnItems.has(result.operationId))
    .sort((left, right) => left.acceptedSequence - right.acceptedSequence);
  const placed: SnapshotDisplayItem[] = [];
  let next = 0;
  conversation.forEach((item, index) => {
    if (item.kind === 'user_message') {
      while (next < unowned.length && unowned[next]!.acceptedSequence < item.acceptedSequence) placed.push(unowned[next++]!);
    }
    placed.push(item);
    const operationId = turnOperationId(item);
    const result = operationId === undefined ? undefined : results.get(operationId);
    if (result !== undefined && lastTurnItems.get(result.operationId) === index) placed.push(result);
  });
  return [...placed, ...unowned.slice(next)];
}

function turnOperationId(item: SnapshotDisplayItem): string | undefined {
  return item.kind === 'tool_history' ? item.history.operationId : item.kind === 'user_message' ? item.operationId : undefined;
}

export function snapshotItemKey(item: SnapshotValue): string {
  switch (item.kind) {
    case 'state': return 'state';
    case 'assignment': return 'assignment';
    case 'epic': return JSON.stringify(['epic', item.epic.workspaceId, item.epic.id]);
    case 'tool_history': return JSON.stringify(['tool_history', item.history.operationId, item.history.generation]);
    case 'user_message': return JSON.stringify(['user_message', item.operationId]);
    case 'turn_result': return JSON.stringify(['turn_result', item.operationId]);
    case 'goal': return JSON.stringify(['goal', item.goal.repositoryDirectory, item.goal.id]);
    case 'inquiry': {
      const { target, question } = item.inquiry;
      const owner = target.goalId !== null ? ['goal', target.repositoryDirectory, target.goalId]
        : target.owner.kind === 'repository' ? ['repository', target.owner.repositoryDirectory] : ['workspace', target.owner.workspaceId];
      return JSON.stringify(['inquiry', owner, question.id]);
    }
    case 'display_event': return JSON.stringify(['display_event', item.event.id]);
  }
}

export class SnapshotChanges {
  private baseline: ReadonlyMap<string, string> | undefined;

  read(metadata: Pick<SnapshotRead, 'transferId' | 'conversationId' | 'revision' | 'stateSequence' | 'operationId'>,
    source: AsyncIterable<SnapshotValue>): SnapshotRead {
    const currentBaseline = () => this.baseline;
    const mode = this.baseline === undefined ? 'initial' : 'delta';
    const hashes = new Map<string, string>();
    let exhausted = false;
    let cancelled = false;
    return {
      ...metadata, mode,
      items: (async function* (): AsyncGenerator<SnapshotItem> {
        // 積んだ時点ではなく送り始める時点の基準と比べる。同じ接続で先に送っていた read の完了を基準に含めるため。
        const baseline = mode === 'initial' ? undefined : currentBaseline();
        for await (const item of source) {
          const key = snapshotItemKey(item);
          if (hashes.has(key)) throw new Error('Repeated snapshot item');
          const hash = createHash('sha256').update(JSON.stringify(item)).digest('hex');
          hashes.set(key, hash);
          if (baseline?.get(key) !== hash) yield item;
        }
        if (baseline !== undefined) {
          for (const key of baseline.keys()) if (!hashes.has(key)) yield { kind: 'remove', key };
        }
        exhausted = true;
      })(),
      complete: () => { if (exhausted && !cancelled) this.baseline = hashes; },
      cancel: () => { cancelled = true; },
    };
  }
}
