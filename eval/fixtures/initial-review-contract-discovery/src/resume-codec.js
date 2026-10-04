const LEGACY_NAMESPACE = /^iteration-(\d+)--step-(.+)$/;

export function saveResumeNamespace(callPath) {
  return `iteration-1--step-${callPath.at(-1)}`;
}

export function restoreResumeNamespace(namespace) {
  const legacy = LEGACY_NAMESPACE.exec(namespace);
  if (legacy === null) {
    throw new Error(`Invalid resume namespace: ${namespace}`);
  }
  return legacy[2];
}
