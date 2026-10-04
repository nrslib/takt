export function consumerB(primary, secondary, key) {
  return primary.has(key) ? primary.get(key) : secondary.get(key);
}
