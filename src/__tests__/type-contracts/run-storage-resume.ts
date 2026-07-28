import {
  resumeRunStorage,
  type RunStorageRoot,
} from '../../infra/run-storage/index.js';

declare const source: RunStorageRoot;

const resumed: RunStorageRoot = resumeRunStorage({
  databasePath: '/tmp/run.sqlite',
  source,
  run: {
    runId: 'child',
    findingContractEnabled: true,
  },
  workflowDefinition: {
    name: 'default',
    codecName: 'json-v1',
    definition: '{"name":"default"}',
  },
  bootstrapSeed: {
    version: 1,
    task: 'task',
    workflowName: 'default',
    projectCwd: '/tmp',
    backend: 'sqlite',
    startedAt: '2026-07-28T00:00:00.000Z',
    sessionId: 'session',
    resumeSource: null,
  },
});

resumeRunStorage({
  databasePath: '/tmp/forged.sqlite',
  // @ts-expect-error Resume accepts only a live RunStorageRoot authority.
  source: source.readResumeSnapshot(),
  run: {
    runId: 'forged',
    findingContractEnabled: true,
  },
  workflowDefinition: {
    name: 'default',
    codecName: 'json-v1',
    definition: '{"name":"default"}',
  },
  bootstrapSeed: {
    version: 1,
    task: 'task',
    workflowName: 'default',
    projectCwd: '/tmp',
    backend: 'sqlite',
    startedAt: '2026-07-28T00:00:00.000Z',
    sessionId: 'session',
    resumeSource: null,
  },
});

void resumed;
