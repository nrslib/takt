import { createHash } from 'node:crypto';
import type { SnapshotItem, SnapshotRead, SnapshotValue } from './conversationPort.js';
import { compareInquiries } from '../../infra/goals/inquiry-order.js';

export type SnapshotDisplayItem = Exclude<SnapshotValue, { kind: 'state' }>;

export function orderSnapshotItems(items: ReadonlyMap<string, SnapshotDisplayItem>): SnapshotDisplayItem[] {
  const assignment = items.get('assignment');
  const repositories = new Map(assignment?.kind === 'assignment'
    ? assignment.assignment.repositoryDirectories.map((directory, index) => [directory, index]) : []);
  const groups = { assignment: 0, goal: 1, inquiry: 2, display_event: 3, tool_history: 4 };
  return [...items.values()].sort((left, right) => {
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
}

export function snapshotItemKey(item: SnapshotValue): string {
  switch (item.kind) {
    case 'state': return 'state';
    case 'assignment': return 'assignment';
    case 'tool_history': return 'tool_history';
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
  private active: object | undefined;

  /**
   * 前回の読込からの差分を作る。ツール履歴は差分配信で追いつくので、内容を比べずに次のように扱う。
   * toolHistory を指定した読込（初回と、差分の起点を取り直すとき）では必ず送り、指定しない読込では送らず消しもしない。
   * ただし完了した読込がまだない（initial を返す）ときは、受け手が手元の項目を作り直すので指定に関係なく送る。
   */
  read(metadata: Pick<SnapshotRead, 'transferId' | 'conversationId' | 'revision' | 'stateSequence' | 'operationId'>,
    source: AsyncIterable<SnapshotValue>, toolHistory: boolean): SnapshotRead {
    const token = {};
    this.active = token;
    const baseline = this.baseline;
    const sendToolHistory = toolHistory || baseline === undefined;
    const hashes = new Map<string, string>();
    let exhausted = false;
    return {
      ...metadata, mode: baseline === undefined ? 'initial' : 'delta',
      items: (async function* (): AsyncGenerator<SnapshotItem> {
        for await (const item of source) {
          const key = snapshotItemKey(item);
          if (hashes.has(key)) throw new Error('Repeated snapshot item');
          if (item.kind === 'tool_history') {
            if (!sendToolHistory) continue;
            const { operationId, generation, finished, history } = item.history;
            hashes.set(key, JSON.stringify([operationId, generation, history.sequence, finished]));
            yield item;
            continue;
          }
          const hash = createHash('sha256').update(JSON.stringify(item)).digest('hex');
          hashes.set(key, hash);
          if (baseline?.get(key) !== hash) yield item;
        }
        const previousToolHistory = baseline?.get('tool_history');
        if (!sendToolHistory && previousToolHistory !== undefined) hashes.set('tool_history', previousToolHistory);
        if (baseline !== undefined) {
          for (const key of baseline.keys()) if (!hashes.has(key)) yield { kind: 'remove', key };
        }
        exhausted = true;
      })(),
      complete: () => {
        if (this.active !== token || !exhausted) return;
        this.baseline = hashes;
        this.active = undefined;
      },
      cancel: () => { if (this.active === token) this.active = undefined; },
    };
  }
}
