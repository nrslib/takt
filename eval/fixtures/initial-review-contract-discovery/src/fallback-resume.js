export function fallbackResumeKey(path) {
  return path.map(({ name, attempt }) => `${name}|${attempt}`).join('|');
}
