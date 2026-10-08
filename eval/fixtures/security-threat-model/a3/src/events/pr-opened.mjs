import { mergePr } from '../features/merge/index.mjs';

export function onPullRequestEvent(event, dependencies) {
  if (event.action !== 'opened') return;
  return mergePr({
    repository: dependencies.repository,
    prNumber: event.pull_request.number,
    provider: dependencies.provider,
    writeToken: dependencies.writeToken,
  });
}
