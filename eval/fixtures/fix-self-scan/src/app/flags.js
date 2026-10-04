// CLI flag helpers: raw argv values arrive as strings or undefined.
export function normalizeFlagValue(value) {
  if (value === undefined) return undefined;
  const trimmed = String(value).trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

export function parseProviderFlags(argv) {
  return {
    provider: normalizeFlagValue(argv.provider),
    model: normalizeFlagValue(argv.model),
  };
}
