import {
  resumeRunStorage,
  type RunStorageRoot,
} from '../../infra/run-storage/index.js';

declare const source: RunStorageRoot;

const resumed: RunStorageRoot = resumeRunStorage({
  databasePath: '/tmp/run.sqlite',
  source,
  run: {
    slug: 'child',
    findingContractEnabled: true,
  },
  workflowDefinition: {
    name: 'default',
    codecName: 'json-v1',
    definition: '{"name":"default"}',
  },
});

resumeRunStorage({
  databasePath: '/tmp/forged.sqlite',
  // @ts-expect-error Resume accepts only a live RunStorageRoot authority.
  source: source.readResumeSnapshot(),
  run: {
    slug: 'forged',
    findingContractEnabled: true,
  },
  workflowDefinition: {
    name: 'default',
    codecName: 'json-v1',
    definition: '{"name":"default"}',
  },
});

void resumed;
