export function consumerC(cache, keys) {
  return Promise.all(keys.map(async (key) => cache.get(key)));
}
