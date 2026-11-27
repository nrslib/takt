import { pathToFileURL } from 'node:url';
import { fetchPullRequest } from './integration.mjs';
import { displayTitle } from './title.mjs';

export function renderPullRequest(pullRequest) {
  return displayTitle(pullRequest.title);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(renderPullRequest(await fetchPullRequest(process.argv[2])));
}
