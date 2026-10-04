import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import CliReviewAdjudicationProvider, {
  formatAdjudicationOutput,
  renderAdjudicationPrompt,
  resolveAdjudicationPrompt,
  writeReviewerReport,
} from './cli-review-adjudication.mjs';

test('renders task and reviewer analysis into an adjudication prompt', () => {
  assert.equal(
    renderAdjudicationPrompt('{{task}}\n{{previous_response}}\n{{scenario}}', {
      task: '要求',
      previousResponse: 'レビュー分析',
      scenario: '',
    }),
    '要求\nレビュー分析\n',
  );
});

test('does not expand template markers contained in stage values', () => {
  assert.equal(
    renderAdjudicationPrompt('{{task}}\n{{previous_response}}', {
      task: '要求 {{previous_response}}',
      previousResponse: 'レビュー分析 {{scenario}}',
      scenario: 'シナリオ',
    }),
    '要求 {{previous_response}}\nレビュー分析 {{scenario}}',
  );
});

test('rejects an adjudication prompt outside its configured root', () => {
  assert.throws(
    () => resolveAdjudicationPrompt('../outside.md', '/tmp/review-eval-root'),
    /must be under the eval directory/,
  );
});

test('writes reviewer reports only by file name', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'takt-review-adjudication-report-'));
  try {
    writeReviewerReport(cwd, 'testing-review.md', 'review');
    assert.equal(
      readFileSync(join(cwd, '.takt', 'runs', 'eval', 'reports', 'testing-review.md'), 'utf8'),
      'review',
    );
    assert.throws(
      () => writeReviewerReport(cwd, '../outside.md', 'invalid'),
      /must be a file name/,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('runs the reviewer and review-adjudication in order with a shared report', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'takt-review-adjudication-'));
  const prompts = [];
  const responses = [
    'testing-review の分析',
    'testing-review の報告',
    '裁定の分析',
    '裁定結果',
  ];
  let createdSessions = 0;
  let cleaned = false;
  const provider = new CliReviewAdjudicationProvider({
    config: {
      reviewer_report_prompt: 'prompts/reviewer-report.md',
      reviewer_report: 'testing-review.md',
      adjudication_prompt: 'prompts/adjudication.md',
      adjudication_report_prompt: 'prompts/adjudication-report.md',
      adjudication_report: 'review-resolution.md',
    },
  }, {
    prepareWorkingDirectory: () => ({
      sourceDirectory: '/source/project',
      cwd,
      cleanup: () => { cleaned = true; },
    }),
    readPrompt: (path) => {
      if (path.endsWith('reviewer-report.md')) {
        return 'reviewer-report /source/project {{task}} {{previous_response}}';
      }
      if (path.endsWith('adjudication.md')) {
        return 'adjudication /source/project {{task}} {{previous_response}}';
      }
      return 'adjudication-report /source/project {{task}} {{previous_response}}';
    },
    createCliReviewSession: () => {
      const sessionIndex = createdSessions * 2;
      createdSessions += 1;
      let turn = 0;
      return {
        run: async (prompt) => {
          prompts.push(prompt);
          const response = responses[sessionIndex + turn];
          turn += 1;
          return response;
        },
      };
    },
  });

  try {
    const result = await provider.callApi('reviewer /source/project 要求', {
      vars: { task: '要求' },
    });

    assert.deepEqual(prompts, [
      `reviewer ${cwd} 要求`,
      `reviewer-report ${cwd} 要求 testing-review の分析`,
      `adjudication ${cwd} 要求 `,
      `adjudication-report ${cwd} 要求 裁定の分析`,
    ]);
    assert.equal(
      readFileSync(join(cwd, '.takt', 'runs', 'eval', 'reports', 'testing-review.md'), 'utf8'),
      'testing-review の報告',
    );
    assert.deepEqual(result, {
      output: formatAdjudicationOutput(
        'testing-review.md',
        'testing-review の報告',
        'review-resolution.md',
        '裁定結果',
      ),
    });
    assert.equal(cleaned, true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('identifies the failed stage and cleans the isolated working directory', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'takt-review-adjudication-error-'));
  let callCount = 0;
  let cleaned = false;
  const provider = new CliReviewAdjudicationProvider({
    config: {
      reviewer_report_prompt: 'prompts/reviewer-report.md',
      reviewer_report: 'testing-review.md',
      adjudication_prompt: 'prompts/adjudication.md',
      adjudication_report_prompt: 'prompts/adjudication-report.md',
      adjudication_report: 'review-resolution.md',
    },
  }, {
    prepareWorkingDirectory: () => ({
      sourceDirectory: cwd,
      cwd,
      cleanup: () => { cleaned = true; },
    }),
    readPrompt: () => '{{task}} {{previous_response}}',
    createCliReviewSession: () => ({
      run: async () => {
        callCount += 1;
        if (callCount === 3) throw new Error('provider failed');
        return `response-${callCount}`;
      },
    }),
  });

  try {
    const result = await provider.callApi('reviewer', { vars: { task: '要求' } });

    assert.match(result.error, /stage "adjudication-analysis" failed: provider failed/);
    assert.equal(cleaned, true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
