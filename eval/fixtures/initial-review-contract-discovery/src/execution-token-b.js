export function tokenB(path) {
  return path.map(({ name, attempt }) => `${name}|${attempt}`).join('|');
}
