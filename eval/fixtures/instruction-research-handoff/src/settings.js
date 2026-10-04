export function resolveSetting(value, fallback = undefined) {
  return value === undefined ? fallback : value;
}
