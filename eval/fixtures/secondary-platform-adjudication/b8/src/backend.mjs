export function configuredBackend(config) {
  return config.backend ?? 'file';
}

export function startJob(config) {
  const backend = configuredBackend(config);
  if (backend !== 'socket') throw new Error('unsupported backend');
  return { running: true, backend };
}
