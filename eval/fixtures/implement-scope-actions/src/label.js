export function formatLabel(value) {
  if (typeof value !== 'string') throw new TypeError('Expected a string');
  return value;
}
