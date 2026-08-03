export interface ResumeRecord {
  namespace: string;
}

const LEGACY_NAMESPACE = /^iteration-(\d+)--step-(.+)$/;

export function serializeResumeNamespace(callPath: string): string {
  return `call-path:${callPath}`;
}

export function parseResumeNamespace(record: ResumeRecord): string {
  if (record.namespace.startsWith('call-path:')) {
    return record.namespace.slice('call-path:'.length);
  }

  const legacy = LEGACY_NAMESPACE.exec(record.namespace);
  if (legacy !== null) {
    return `root/${legacy[2]}`;
  }

  throw new Error(`Invalid resume namespace: ${record.namespace}`);
}
