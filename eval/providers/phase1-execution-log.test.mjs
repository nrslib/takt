import assert from 'node:assert/strict';
import test from 'node:test';
import buildPhase1ExecutionLogPrompt from '../phase1-execution-log-prompt.mjs';
import Phase1ExecutionLogProvider from './phase1-execution-log.mjs';

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
