export function tokenC(path) {
  return path.map(({ name }) => name).join('|');
}
