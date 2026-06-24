import type { ExecConfig } from './types.js';

export const DEFAULT_EXEC_CONFIG: ExecConfig = {
  session: {
    provider: 'claude',
    model: 'opus',
    effort: 'high',
  },
  replan: {
    instruction: 'exec-replan',
    knowledge: ['architecture'],
    policy: [],
  },
  workers: [
    {
      name: 'worker-1',
      provider: 'claude',
      model: 'sonnet',
      effort: 'high',
      instruction: 'exec-worker',
      knowledge: ['architecture'],
      policy: ['coding', 'testing'],
    },
  ],
  judges: [
    {
      name: 'judge-1',
      provider: 'claude',
      model: 'opus',
      effort: 'high',
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
