function normalizeKey(key) {
  return key.trim().toLowerCase();
}

export class Cache {
  #entries = new Map();

  set(key, value) {
    this.#entries.set(normalizeKey(key), value);
  }

  get(key) {
    return this.#entries.get(key);
  }
}
