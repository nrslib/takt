export function isPlanningBudgetError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.message.includes('max_total_parts')
    || /^Structured output produced too many parts: \d+ > \d+$/.test(error.message);
}
