import assert from 'node:assert/strict';
import { createPrimaryKey } from '../src/primary-key.js';

assert.notEqual(
  createPrimaryKey({ tenantId: 'tenant-a', jobId: 'job-1' }),
  createPrimaryKey({ tenantId: 'tenant-b', jobId: 'job-1' }),
);
