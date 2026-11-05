import { deleteManagerEvent, readManagerEvents } from '../../infra/goals/events.js';

/** ゴール単位の旧 patrol は、新しいリポジトリ単位の予定へ持ち越さない。 */
export function retirePendingPatrols(repositoryDirectory: string): number {
  let retired = 0;
  for (const saved of readManagerEvents(repositoryDirectory)) {
    if (saved.event.kind !== 'patrol') continue;
    deleteManagerEvent(saved);
    retired++;
  }
  return retired;
}
