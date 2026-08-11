export function cacheReadWithFallback(primary, fallback, key) {
  return primary.has(key) ? primary.get(key) : fallback.get(key);
}
