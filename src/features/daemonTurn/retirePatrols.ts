import { deleteManagerEvent, readManagerEvents } from '../../infra/goals/events.js';

/** Legacy patrols have no model turn in the event-driven daemon. */
export function retirePendingPatrols(repositoryDirectory: string): number {
  let retired = 0;
  for (const saved of readManagerEvents(repositoryDirectory)) {
    if (saved.event.kind !== 'patrol') continue;
    deleteManagerEvent(saved);
    retired++;
  }
  return retired;
}
