import { addManager } from './director.mjs';

export function receiveWatchObservation(repositoryDirectory) {
  const event = { kind: 'watch_observation' };
  return addManager(event, repositoryDirectory);
}
