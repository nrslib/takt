export function createCache(now = Date.now) {
  const entries = new Map();
  return {
    put(key, value) { entries.set(key, { value, createdAt: now() }); },
    get(key) {
      const entry = entries.get(key);
      return entry && now() - entry.createdAt < 20 ? entry.value : undefined;
    },
  };
}
