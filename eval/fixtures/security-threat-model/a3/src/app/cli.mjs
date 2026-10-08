import { mergePr } from '../features/merge/index.mjs';

export function mergeCommand({ repository, prNumber, provider, writeToken }) {
  return mergePr({ repository, prNumber, provider, writeToken });
}
