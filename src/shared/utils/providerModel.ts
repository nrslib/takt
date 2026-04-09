/**
 * Parse provider/model identifier.
 *
 * Expected format: "<provider>/<model>" with both segments non-empty.
 */
export function parseProviderModel(value: string, fieldName: string): { providerID: string; modelID: string } {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${fieldName} must not be empty`);
  }

  const slashIndex = trimmed.indexOf('/');
  if (slashIndex <= 0 || slashIndex === trimmed.length - 1) {
    throw new Error(`${fieldName} must be in 'provider/model' format: received '${value}'`);
  }

  return {
    providerID: trimmed.slice(0, slashIndex),
    modelID: trimmed.slice(slashIndex + 1),
  };
}
