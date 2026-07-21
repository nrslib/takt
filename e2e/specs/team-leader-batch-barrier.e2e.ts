import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { createIsolatedEnv, type IsolatedEnv } from '../helpers/isolated-env';
import { createLocalRepo, type LocalRepo } from '../helpers/test-repo';
import { runTakt } from '../helpers/takt-runner';
import { readSessionRecords } from '../helpers/session-log';
import { copyWorkflowFixtureToRepo } from '../helpers/local-workflow-fixture';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function countPartSections(stepContent: string): number {
  const matches = stepContent.match(/^## [^:\n]+: .+$/gm);
  return matches?.length ?? 0;
}

interface MockCallRecord {
  readonly event: 'start' | 'complete';
  readonly personaName: string;
}

function readMockCallRecords(path: string): MockCallRecord[] {
  return readFileSync(path, 'utf-8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as MockCallRecord);
}

describe('E2E: Team leader batch barrier', () => {
  let isolatedEnv: IsolatedEnv;
  let repo: LocalRepo;

  beforeEach(() => {
    isolatedEnv = createIsolatedEnv();
    delete isolatedEnv.env.CLAUDECODE;
    repo = createLocalRepo();
  });

  afterEach(() => {
    try { repo.cleanup(); } catch { /* best-effort */ }
    try { isolatedEnv.cleanup(); } catch { /* best-effort */ }
  });

  it('initial_max_parts の初回バッチ完了後にだけ次バッチを計画する', () => {
    const workflowPath = copyWorkflowFixtureToRepo(
      repo.path,
      resolve(__dirname, '../fixtures/workflows/team-leader-batch-barrier.yaml'),
    );
    const scenarioPath = resolve(__dirname, '../fixtures/scenarios/team-leader-batch-barrier.json');
    const mockCallLogPath = join(repo.path, '.takt-mock-call-log.ndjson');
    const result = runTakt({
      args: [
        '--provider', 'mock',
        '--task',
        'Create exactly four files: bb-1.txt, bb-2.txt, bb-3.txt, bb-4.txt. Each file must contain its own filename as content. Each part must create exactly one file.',
        '--workflow',
        workflowPath,
      ],
      cwd: repo.path,
      env: {
        ...isolatedEnv.env,
        TAKT_MOCK_SCENARIO: scenarioPath,
        TAKT_MOCK_CALL_LOG: mockCallLogPath,
      },
      timeout: 120_000,
    });

    if (result.exitCode !== 0) {
      console.log('=== STDOUT ===\n', result.stdout);
      console.log('=== STDERR ===\n', result.stderr);
    }

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Workflow completed');

    const records = readSessionRecords(repo.path);
    const initialDecomposition = records.find((r) =>
      r.type === 'phase_complete'
      && r.step === 'execute'
      && r.phase === 1
      && r.phaseName === 'execute'
    );
    const stepComplete = records.find((r) => r.type === 'step_complete' && r.step === 'execute');
    expect(initialDecomposition).toBeDefined();
    expect(stepComplete).toBeDefined();

    expect(JSON.parse(String(initialDecomposition?.content ?? '')).parts).toHaveLength(2);
    const content = String(stepComplete?.content ?? '');
    const partSectionCount = countPartSections(content);
    expect(partSectionCount).toBe(4);
    expect(content).toContain('## bb-1: Create bb-1.txt');
    expect(content).toContain('## bb-2: Create bb-2.txt');
    expect(content).toContain('## bb-3: Create bb-3.txt');
    expect(content).toContain('## bb-4: Create bb-4.txt');

    const calls = readMockCallRecords(mockCallLogPath);
    const leaderStartIndexes = calls.flatMap((call, index) =>
      call.event === 'start' && call.personaName === 'agents/test-team-leader-batch-barrier'
        ? [index]
        : [],
    );
    const initialMemberCompletionIndexes = calls.flatMap((call, index) =>
      call.event === 'complete' && call.personaName === 'agents/test-coder'
        ? [index]
        : [],
    ).slice(0, 2);

    expect(leaderStartIndexes).toHaveLength(2);
    expect(initialMemberCompletionIndexes).toHaveLength(2);
    expect(leaderStartIndexes[1]).toBeGreaterThan(Math.max(...initialMemberCompletionIndexes));
  }, 120_000);
});
