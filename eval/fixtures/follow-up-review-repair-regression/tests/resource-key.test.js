import assert from 'node:assert/strict';
import { publishResource } from '../src/application.js';
import { createPrimaryKey } from '../src/primary-key.js';

assert.notEqual(
  createPrimaryKey({ tenantId: 'tenant-a', jobId: 'job-1' }),
  createPrimaryKey({ tenantId: 'tenant-b', jobId: 'job-1' }),
);

assert.deepEqual(
  publishResource({ tenantId: 'tenant-a', jobId: 'job-1' }, 'ready').card,
  { card: 'tenant-a/job-1', note: null },
);

assert.deepEqual(
  publishResource({ tenantId: 'tenant-a', jobId: 'job-1', resolverResult: 'missing' }, 'ready').card,
  { card: null, note: 'identity not found' },
);
