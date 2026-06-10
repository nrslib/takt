export function isPlanningBudgetError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message;
  return /^Initial team leader parts exceed max_total_parts: \d+ > \d+$/.test(message)
    || /^Team leader planned parts exceed max_total_parts: \d+ > \d+$/.test(message)
    || /^Team leader produced too many total parts: \d+ > max_total_parts \d+$/.test(message)
    || /^Structured output produced too many total parts: \d+ > max_total_parts \d+$/.test(message)
    || /^Structured output produced too many parts: \d+ > \d+$/.test(message);
}
