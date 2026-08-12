export async function consumerA(cache, key, attempts) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = cache.get(key);
    if (value !== undefined) return value;
  }
  return undefined;
}
