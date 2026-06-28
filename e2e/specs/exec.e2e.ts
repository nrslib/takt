import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { createIsolatedEnv, type IsolatedEnv } from '../helpers/isolated-env';
import { createTestRepo, type TestRepo } from '../helpers/test-repo';
import { formatTaktRunResult, runTakt } from '../helpers/takt-runner';

// E2E更新時は docs/testing/e2e.md も更新すること
describe('E2E: Exec mode (takt exec)', () => {
  let isolatedEnv: IsolatedEnv;
  let testRepo: TestRepo;

  beforeEach(() => {
    isolatedEnv = createIsolatedEnv();
    testRepo = createTestRepo();
  });

  afterEach(() => {
    const cleanupErrors: unknown[] = [];
    try {
      testRepo.cleanup();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      isolatedEnv.cleanup();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length === 1) {
      throw cleanupErrors[0];
    }
    if (cleanupErrors.length > 1) {
      throw new AggregateError(cleanupErrors, 'E2E cleanup failed');
    }
  });

  it('should list builtin exec presets with exec --list', () => {
    const result = runTakt({
      args: ['exec', '--list'],
      cwd: testRepo.path,
      env: isolatedEnv.env,
    });
    expect(result.exitCode, formatTaktRunResult(result)).toBe(0);
    expect(result.stdout).toContain('backend');
    expect(result.stdout).toContain('frontend');
    expect(result.stdout).toContain('dual');
    expect(result.stdout).toContain('research');
  });

  it('should start exec with the previous configuration when it exists', () => {
    mkdirSync(isolatedEnv.taktDir, { recursive: true });
    writeFileSync(join(isolatedEnv.taktDir, 'exec.yaml'), [
      'session:',
      '  provider: mock',
      '  model: previous-session',
      'replan:',
      '  instruction: exec-replan',
      '  knowledge: []',
      '  policy: []',
      'workers:',
      '  - name: worker-1',
      '    provider: mock',
      '    model: previous-worker',
      '    instruction: exec-worker',
      '    knowledge: []',
      '    policy: []',
      'reviews:',
      '  - name: review-1',
      '    provider: mock',
      '    model: previous-review',
      '    instruction: exec-review',
      '    knowledge: []',
      '    policy: []',
      'loop:',
      '  threshold: 3',
      '  large_threshold: 2',
      '  max_steps: 20',
    ].join('\n'));

    const result = runTakt({
      args: ['exec'],
      cwd: testRepo.path,
      env: isolatedEnv.env,
      input: '/cancel\n',
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Previous configuration');
    expect(result.stdout).toContain('Assistant agent: mock/previous-session');
    expect(result.stdout).toContain('Worker agent x1: mock/previous-worker');
    expect(result.stdout).toContain('Review agent x1: mock/previous-review');
  });

  it('should expose setup during exec conversation', () => {
    const result = runTakt({
      args: ['exec', 'backend'],
      cwd: testRepo.path,
      env: isolatedEnv.env,
      input: '/setup\n/cancel\n',
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Exec agents');
    expect(result.stdout).toContain('Assistant agent:');
  });

  it('should execute /go through a generated workflow using the existing workflow engine', () => {
    const scenarioPath = join(isolatedEnv.taktDir, 'exec-scenario.json');
    mkdirSync(isolatedEnv.taktDir, { recursive: true });
    writeFileSync(scenarioPath, JSON.stringify([
      {
        persona: 'exec-assistant',
        status: 'done',
        content: 'Task is ready for execution.',
      },
      {
        persona: 'exec-worker',
        status: 'done',
        content: '[WORKER-1:1]\ndone',
      },
      {
        persona: 'conductor',
        status: 'done',
        content: '[WORKER-1:1]',
      },
      {
        persona: 'conductor',
        status: 'done',
        content: '[WORKER-1:1]',
      },
      {
        persona: 'exec-assistant',
        status: 'done',
        content: '[REVIEW-1:1]\napproved',
      },
      {
        persona: 'exec-assistant',
        status: 'done',
        content: '# Review Result\n\napproved',
      },
      {
        persona: 'conductor',
        status: 'done',
        content: '[REVIEW-1:1]',
      },
      {
        persona: 'conductor',
        status: 'done',
        content: '[REVIEW-1:1]',
      },
      {
        persona: 'exec-assistant',
        status: 'done',
        content: 'Execution completed.',
      },
    ]));
    const result = runTakt({
      args: ['--provider', 'mock', 'exec', 'backend'],
      cwd: testRepo.path,
      env: {
        ...isolatedEnv.env,
        TAKT_MOCK_SCENARIO: scenarioPath,
      },
      input: '/go Implement a small mock task\n/cancel\n',
      timeout: 240_000,
    });
    expect(result.exitCode, formatTaktRunResult(result)).toBe(0);
    expect(result.stdout).toContain('Workflow completed');
    const workflowPath = join(testRepo.path, '.takt', 'exec', 'workflow.yaml');
    expect(existsSync(workflowPath)).toBe(true);
    const workflow = parseYaml(readFileSync(workflowPath, 'utf-8')) as {
      steps: Array<{
        name: string;
        provider?: string;
        parallel?: Array<{ provider?: string }>;
      }>;
    };
    const execute = workflow.steps.find((step) => step.name === 'execute');
    const review = workflow.steps.find((step) => step.name === 'review');
    const replan = workflow.steps.find((step) => step.name === 'replan');
    expect(execute?.parallel?.[0]?.provider).toBe('mock');
    expect(review?.parallel?.[0]?.provider).toBe('mock');
    expect(replan?.provider).toBe('mock');
    expect(existsSync(join(isolatedEnv.taktDir, 'exec.yaml'))).toBe(false);
  }, 240_000);

  it('should not create exec workflow or config when /go has no task context', () => {
    const result = runTakt({
      args: ['exec', 'backend'],
      cwd: testRepo.path,
      env: isolatedEnv.env,
      input: '/go\n/cancel\n',
      timeout: 240_000,
    });
    expect(result.exitCode, formatTaktRunResult(result)).toBe(0);
    expect(result.stdout).toContain('Conversation or task text is required for /go.');
    expect(existsSync(join(testRepo.path, '.takt', 'exec', 'workflow.yaml'))).toBe(false);
    expect(existsSync(join(isolatedEnv.taktDir, 'exec.yaml'))).toBe(false);
  }, 240_000);
});
