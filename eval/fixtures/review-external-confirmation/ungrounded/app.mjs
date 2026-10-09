export function launch(environment, owner) {
  if (!['local', 'remote'].includes(environment)) throw new Error('unsupported environment');
  return { running: true, environment, owner };
}
