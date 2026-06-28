import type { ExecConfig } from './types.js';

export const DEFAULT_EXEC_CONFIG: ExecConfig = {
  session: {},
  replan: {
    instruction: 'exec-replan',
    knowledge: ['architecture'],
    policy: [],
  },
  workers: [
    {
      name: 'worker-1',
      instruction: 'exec-worker',
      knowledge: ['architecture'],
      policy: ['coding', 'testing'],
    },
  ],
  judges: [
    {
      name: 'judge-1',
      instruction: 'exec-judge',
      knowledge: ['architecture'],
      policy: ['review'],
    },
  ],
  loop: {
    smallThreshold: 3,
    largeThreshold: 2,
    maxSteps: 20,
  },
};
