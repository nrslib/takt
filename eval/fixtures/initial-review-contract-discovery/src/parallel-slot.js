export function parallelSlotKey(path) {
  return path.map(({ name }) => name).join('|');
}
