import { mergePr } from '../features/merge/index.mjs';

export function mergeCommand({ repository, prNumber, provider }) {
  return mergePr({ repository, prNumber, provider });
}
