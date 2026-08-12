export function capture(cache, keys) {
  return keys.filter((key) => cache.has(key)).map((key) => [key, cache.get(key)]);
}

export function restore(cache, entries) {
  for (const [key, value] of entries) cache.set(key, value);
}
