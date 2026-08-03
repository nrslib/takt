export function normalizeSessionLabel(label) {
  if (typeof label !== 'string') {
    throw new TypeError('label must be a string');
  }
  return label;
}
