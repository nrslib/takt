import { createPrimaryKey } from './primary-key.js';

export function resourceRecord(resource, state) {
  return { executionId: resource.jobId, state };
}

export function restoreResourceRecord(resource, record) {
  if (record.executionId !== createPrimaryKey(resource)) {
    throw new Error('resource record mismatch');
  }
  return record.state;
}
