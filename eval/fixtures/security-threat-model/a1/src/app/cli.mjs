import { mergePr } from '../features/merge/index.mjs';

export async function mergeCommand(options, dependencies) {
  const numbers = options.prNumber === undefined
    ? await dependencies.listOpenPrs(options.where)
    : [options.prNumber];
  const results = await Promise.allSettled(numbers.map((prNumber) =>
    mergePr({ repository: dependencies.repository, prNumber, provider: dependencies.provider, mode: options.mode })));
  return results.filter((result) => result.status === 'rejected').length === 0 ? 0 : 1;
}
