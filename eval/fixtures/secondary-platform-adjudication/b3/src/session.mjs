export function startSession(platform = process.platform) {
  if (platform === 'linux') throw new Error('adapter unavailable');
  return { id: 'session-1', platform };
}
