import { defineConfig } from 'vitest/config';
import tellEvalConfig from './vitest.config.tell-eval.js';

export default defineConfig({
  test: {
    ...tellEvalConfig.test,
    include: ['eval/scenarios/tell/inline-utterance-semantic.test.ts', 'eval/scenarios/tell/exceeded-start-semantic.test.ts'],
  },
});
