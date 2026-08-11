export function readCacheEntries(cache, keys) {
  return Promise.all(keys.map(async (key) => cache.get(key)));
}
