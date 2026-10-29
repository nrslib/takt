import assert from 'node:assert/strict';
import test from 'node:test';
import buildPhase1ExecutionLogPrompt from '../phase1-execution-log-prompt.mjs';
import Phase1ExecutionLogProvider from './phase1-execution-log.mjs';
import {
  buildLogAccessContinuation,
  executePhase1LogRequest,
  LOG_BUDGET_EXHAUSTED_CONTINUATION,
  PHASE1_LOG_MAX_RESPONSE_BYTES,
} from '../../dist/core/workflow/phase1-log-access.js';

const vars = {
  task: 'PR の変更をレビューし、実際の確認範囲を報告する。',
  last_response: '{"result":"APPROVE"}',
  phase1_log: JSON.stringify([
    { kind: 'provider_event', event: { type: 'tool_result', data: { id: 'call-1', content: 'diff --git a/current.ts b/current.ts', isError: false } } },
    { kind: 'attempt_result', status: 'done', content: '{"result":"APPROVE"}' },
  ]),
};

for (const language of ['ja', 'en']) {
  test(`resolves the ${language} prompt reference and mediates search through the final report`, async () => {
    const prompt = await buildPhase1ExecutionLogPrompt({ vars: { ...vars, language } });
    const prompts = [];
    let cleaned = false;
    const provider = new Phase1ExecutionLogProvider({
      config: { cli: 'codex', model: 'offline', working_dir: 'fixture' },
    }, {
      prepareWorkingDirectory: () => ({
        sourceDirectory: '/fixture',
        cwd: '/fixture',
        cleanup: () => { cleaned = true; },
      }),
      createCliReviewSession: () => ({
        run: async (input) => {
          prompts.push(input);
          return prompts.length === 1
            ? JSON.stringify({ _takt_phase1_log_request: {
              operation: 'search', offset: 0, limit: 128, query: 'diff --git',
            } })
            : '# Final report';
        },
      }),
    });

    const result = await provider.callApi(prompt, {});

    assert.deepEqual(result, { output: '# Final report' });
    assert.equal(prompts.length, 2);
    assert.equal(prompts[0], prompt);
    assert.match(prompts[1], /Engine-mediated Phase 1 Execution Record Result/);
    assert.match(prompts[1], /"matchCount":1/);
    assert.match(prompts[1], /@@ \d+\ndiff --git\n/);
    assert.equal(cleaned, true);
  });
}

test('shares production continuation text and enforces request and cumulative byte budgets', async () => {
  const prompt = await buildPhase1ExecutionLogPrompt({ vars: {
    ...vars,
    phase1_log: JSON.stringify([{ kind: 'attempt_result', status: 'done', content: 'x'.repeat(70 * 1024) }]),
  } });
  const responses = [
    ...Array.from({ length: 5 }, (_, index) => JSON.stringify({ _takt_phase1_log_request: {
      operation: 'read',
      offset: index * PHASE1_LOG_MAX_RESPONSE_BYTES,
      limit: PHASE1_LOG_MAX_RESPONSE_BYTES,
    } })),
    '# Final after budget exhaustion',
  ];
  const prompts = [];
  let cleaned = false;
  const provider = new Phase1ExecutionLogProvider({
    config: { cli: 'codex', model: 'offline', working_dir: 'fixture' },
  }, {
    prepareWorkingDirectory: () => ({
      sourceDirectory: '/fixture', cwd: '/fixture', cleanup: () => { cleaned = true; },
    }),
    createCliReviewSession: () => ({
      run: async (input) => {
        const index = prompts.length;
        prompts.push(input);
        return responses[index];
      },
    }),
  });

  const result = await provider.callApi(prompt, {});

  assert.deepEqual(result, { output: '# Final after budget exhaustion' });
  assert.equal(prompts.length, 6);
  const firstRequest = JSON.parse(responses[0])._takt_phase1_log_request;
  const reference = {
    path: prompt.match(/^- パス: (.+)$/m)[1],
    byteSize: Number(prompt.match(/^- バイト数: (\d+)$/m)[1]),
    stepName: 'review',
    stepIteration: 1,
  };
  const firstResult = await executePhase1LogRequest(reference, firstRequest, PHASE1_LOG_MAX_RESPONSE_BYTES);
  assert.equal(prompts[1], buildLogAccessContinuation(firstRequest, firstResult));
  assert.equal(firstResult.content.length, PHASE1_LOG_MAX_RESPONSE_BYTES);
  assert.equal(prompts[5], LOG_BUDGET_EXHAUSTED_CONTINUATION);
  assert.equal(cleaned, true);
});
