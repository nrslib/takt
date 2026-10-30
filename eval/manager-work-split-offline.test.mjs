import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parse, stringify } from 'yaml';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const suite = parse(readFileSync(join(repoRoot, 'eval/scenarios/manager-work-split/manager-work-split.yaml'), 'utf8'));

for (const variant of ['red', 'green']) {
  test(`promptfoo assembles all manager cases with ${variant} instructions and an offline provider`, { timeout: 60000 }, () => {
    const root = mkdtempSync(join(tmpdir(), 'takt-manager-promptfoo-'));
    try {
      const instructionRoot = join(root, 'instructions');
      for (const lang of ['ja', 'en']) {
        mkdirSync(join(instructionRoot, lang), { recursive: true });
        const path = `builtins/${lang}/facets/instructions/manager.md`;
        const body = variant === 'red'
          ? execFileSync('git', ['show', `main:${path}`], { cwd: repoRoot, encoding: 'utf8' })
          : readFileSync(join(repoRoot, path), 'utf8');
        writeFileSync(join(instructionRoot, lang, 'manager.md'), body);
      }
      // Semantic grading is intentionally excluded: this checks promptfoo assembly without a model.
      const config = {
        prompts: [ `file://${join(repoRoot, 'eval/manager-work-split-prompt.mjs')}` ],
        providers: [{ id: `file://${join(repoRoot, 'eval/providers/manager-work-split-offline.mjs')}` }],
        evaluateOptions: suite.evaluateOptions,
        tests: suite.tests.map(({ description, vars }) => ({
          description, vars, assert: [{ type: 'equals', value: `${vars.case}/${vars.lang}` }],
        })),
      };
      const configPath = join(root, 'offline.yaml');
      const reportPath = join(root, 'results.json');
      writeFileSync(configPath, stringify(config));
      const env = {
        ...process.env,
        TAKT_EVAL_MANAGER_INSTRUCTION_ROOT: instructionRoot,
        PROMPTFOO_CONFIG_DIR: join(root, 'promptfoo'),
        PROMPTFOO_DISABLE_TELEMETRY: '1',
        PROMPTFOO_DISABLE_UPDATE: '1',
        PROMPTFOO_DISABLE_REMOTE_GENERATION: '1',
      };
      delete env.TAKT_EVAL_MANAGER_OMIT_CONCURRENCY;
      const run = spawnSync(process.execPath, [
        join(repoRoot, 'node_modules/promptfoo/dist/src/entrypoint.js'), 'eval',
        '-c', configPath, '--no-cache', '--no-write', '--no-share', '--no-progress-bar', '--no-table', '-o', reportPath,
      ], { cwd: repoRoot, env, encoding: 'utf8', timeout: 55000, maxBuffer: 2 * 1024 * 1024 });
      assert.ifError(run.error);
      assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
      const report = JSON.parse(readFileSync(reportPath, 'utf8'));
      assert.equal(report.results.stats.successes, suite.tests.length);
      assert.equal(report.results.stats.failures, 0);
      assert.equal(report.results.stats.errors, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
