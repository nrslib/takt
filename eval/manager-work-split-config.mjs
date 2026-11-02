export function filterManagerWorkSplitConfig(config, flags) {
  const index = flags.findIndex((flag) => flag === '--filter-providers' || flag.startsWith('--filter-providers='));
  if (index < 0) return config;
  const value = flags[index].includes('=') ? flags[index].slice('--filter-providers='.length) : flags[index + 1];
  if (value === undefined) throw new Error('--filter-providers requires a pattern');
  const pattern = new RegExp(value);
  const providers = config.providers.filter(({ label, id }) => pattern.test(label) || pattern.test(id));
  const labels = new Set(providers.map(({ label }) => label));
  const tests = config.tests.flatMap((entry) => {
    const selected = entry.providers.filter((label) => labels.has(label));
    return selected.length === 0 ? [] : [{ ...entry, providers: selected }];
  });
  if (tests.length === 0) throw new Error('No manager cases match the selected providers');
  return { ...config, providers, tests };
}
