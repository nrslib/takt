export function createRetryToken(path) {
  const current = path.at(-1);
  return `${current.name}|${current.attempt}`;
}
