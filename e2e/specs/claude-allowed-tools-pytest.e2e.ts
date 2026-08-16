import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  createIsolatedEnv,
  updateIsolatedConfig,
  type IsolatedEnv,
} from '../helpers/isolated-env';
import { createLocalRepo, type LocalRepo } from '../helpers/test-repo';
import { runTakt } from '../helpers/takt-runner';

function isPytestAvailable(): boolean {
  try {
    execFileSync('python3', ['-m', 'pytest', '--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

const pytestAvailable = isPytestAvailable();

describe.skipIf(!pytestAvailable)(
  'E2E: Claude provider_options.claude.allowed_tools for pytest (config.yaml propagation)',
  () => {
    let isolatedEnv: IsolatedEnv;
    let repo: LocalRepo;
    let workflowPath: string;

    beforeEach(() => {
      isolatedEnv = createIsolatedEnv();
      repo = createLocalRepo();

      const testsDir = join(repo.path, 'backend', 'tests');
      mkdirSync(testsDir, { recursive: true });
      writeFileSync(join(testsDir, '__init__.py'), '', 'utf-8');
      writeFileSync(
        join(testsDir, 'test_sample.py'),
        ['def test_one_plus_one():', '    assert 1 + 1 == 2', ''].join('\n'),
        'utf-8',
      );

      workflowPath = join(repo.path, 'pytest-allowed-tools-workflow.yaml');
      writeFileSync(
        workflowPath,
        [
          'name: pytest-allowed-tools-e2e',
          'description: Verify config.yaml provider_options.claude.allowed_tools propagates to claude CLI --allowed-tools',
          'max_steps: 3',
          'initial_step: run_tests',
          'personas:',
          '  pytest-runner: |',
          '    You are a strict test runner. Execute bash commands verbatim as instructed and report the outcome using only the allowed reply keywords.',
          'steps:',
          '  - name: run_tests',
          '    edit: false',
          '    persona: pytest-runner',
          '    required_permission_mode: edit',
          '    instruction: |',
          '      From the repository root, run exactly this bash command (no wrappers, no env prefix, no "sh -c"):',
          '      ',
          '      python3 -m pytest backend/tests -v',
          '      ',
          '      Rules for your reply:',
          '      - If pytest ran and at least one test passed, reply with exactly the single word: Passed',
          '      - If the Bash tool could not run the command (for example "requires approval"), reply with exactly the single word: Blocked',
          '      - If pytest ran but reported any test failure, reply with exactly the single word: Failed',
          '    rules:',
          '      - condition: Passed',
          '        next: COMPLETE',
          '      - condition: Blocked',
          '        next: ABORT',
          '      - condition: Failed',
          '        next: ABORT',
        ].join('\n'),
        'utf-8',
      );

      updateIsolatedConfig(isolatedEnv.taktDir, {
        provider_options: {
          claude: {
            allowed_tools: [
              'Bash(python -m pytest:*)',
              'Bash(python3 -m pytest:*)',
              'Bash(pytest:*)',
              'Bash(which pytest)',
              'Bash(which python3)',
              'Bash(python3 --version)',
            ],
          },
        },
      });
    });

    afterEach(() => {
      try {
        repo.cleanup();
      } catch {
        /* best-effort */
      }
      try {
        isolatedEnv.cleanup();
      } catch {
        /* best-effort */
      }
    });

    it('config.yaml の allowed_tools で approval 無しに pytest が緑化する', () => {
      const result = runTakt({
        args: ['--task', 'Run the pytest suite under backend/tests', '--workflow', workflowPath],
        cwd: repo.path,
        env: isolatedEnv.env,
        timeout: 300_000,
      });

      const combined = `${result.stdout}\n${result.stderr}`;

      expect(combined.includes('requires approval')).toBe(false);
      expect(result.exitCode).toBe(0);
    }, 360_000);
  },
);
