const MAX_NAME_UNITS = 8;

function storageKey(name) {
  return name.normalize('NFKC').toLocaleLowerCase('en-US').slice(0, MAX_NAME_UNITS);
}

export class NameStorage {
  constructor(entries = []) {
    this.entries = new Map(entries);
  }

  write(name, value) {
    this.entries.set(storageKey(name), value);
  }

  read(name) {
    return this.entries.get(storageKey(name));
  }

  snapshot() {
    return JSON.stringify([...this.entries]);
  }

  static reload(snapshot) {
    return new NameStorage(JSON.parse(snapshot));
  }
}
