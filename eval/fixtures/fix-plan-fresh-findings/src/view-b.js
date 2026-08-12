export function viewB(cache, key) {
  return cache.has(key)
    ? { found: true, value: cache.get(key) }
    : { found: false };
}
