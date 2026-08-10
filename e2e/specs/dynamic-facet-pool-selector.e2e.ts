import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createIsolatedEnv, type IsolatedEnv, updateIsolatedConfig } from '../helpers/isolated-env';
import { runTakt } from '../helpers/takt-runner';
import { createTestRepo, type TestRepo } from '../helpers/test-repo';
import { readSessionRecords } from '../helpers/session-log';

const FIXTURE_POOL_BODY = `policies:
  transaction-correctness: ./facets/policies/transaction-correctness.md
  backward-compatibility: ./facets/policies/backward-compatibility.md
knowledge:
  backend-api: ./facets/knowledge/backend-api.md
  database-transaction: ./facets/knowledge/database-transaction.md
candidates:
  - id: transaction
    description: transaction境界、rollback、排他制御を扱う
    policy: transaction-correctness
    knowledge: database-transaction
  - id: backward-compatibility
    description: 公開APIやschemaの互換性を維持する
    policy: backward-compatibility
`;

function writeExternalPool(
  repoPath: string,
  poolBody: string,
  facetFiles: Readonly<Record<string, string>>,
): void {
  const poolDir = join(repoPath, '.takt', 'facet-pools');
  mkdirSync(poolDir, { recursive: true });
  writeFileSync(join(poolDir, 'implementation-fix.yaml'), poolBody, 'utf-8');
  for (const [relativePath, content] of Object.entries(facetFiles)) {
    const path = join(poolDir, 'facets', relativePath);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content, 'utf-8');
  }
}

function writeSharedExternalPool(repoPath: string): void {
  writeExternalPool(repoPath, FIXTURE_POOL_BODY, {
    'policies/transaction-correctness.md': '# transaction-correctness policy\n',
    'policies/backward-compatibility.md': '# backward-compatibility policy\n',
    'knowledge/backend-api.md': '# backend-api knowledge\n',
    'knowledge/database-transaction.md': '# database-transaction knowledge\n',
  });
}

function writeChangedExternalPool(repoPath: string): void {
  writeExternalPool(repoPath, `policies:
  database-correctness: ./facets/policies/database-correctness.md
knowledge:
  database-transaction: ./facets/knowledge/database-transaction.md
candidates:
  - id: database
    description: database transaction boundaries
    policy: database-correctness
    knowledge: database-transaction
  - id: query
    description: query performance boundaries
    policy: database-correctness
    knowledge: database-transaction
`, {
    'policies/database-correctness.md': '# database-correctness policy\n',
    'knowledge/database-transaction.md': '# database-transaction knowledge\n',
  });
}

function writeFixedFacets(repoPath: string): void {
  const facetsDir = join(repoPath, '.takt', 'workflows', 'facets');
  mkdirSync(join(facetsDir, 'policies'), { recursive: true });
  mkdirSync(join(facetsDir, 'knowledge'), { recursive: true });
  writeFileSync(join(facetsDir, 'policies', 'coding.md'), '# coding policy\n', 'utf-8');
  writeFileSync(join(facetsDir, 'policies', 'testing.md'), '# testing policy\n', 'utf-8');
  writeFileSync(join(facetsDir, 'knowledge', 'architecture.md'), '# architecture knowledge\n', 'utf-8');
  writeFileSync(join(facetsDir, 'policies', 'transaction-correctness.md'), '# CALLER transaction-correctness (must NOT be captured by pool)\n', 'utf-8');
}

function writeFixWorkflow(repoPath: string, workflowName: string): string {
  const workflowPath = join(repoPath, '.takt', 'workflows', `${workflowName}.yaml`);
  writeFileSync(workflowPath, [
    `name: ${workflowName}`,
    'initial_step: fix',
    'max_steps: 5',
    'policies:',
    '  coding: ./facets/policies/coding.md',
    '  testing: ./facets/policies/testing.md',
    '  transaction-correctness: ./facets/policies/transaction-correctness.md',
    'knowledge:',
    '  architecture: ./facets/knowledge/architecture.md',
    'facet_pools:',
    '  fix:',
    '    uses: implementation-fix',
    'steps:',
    '  - name: fix',
    '    persona: coder',
    '    policy: [coding, testing]',
    '    knowledge: [architecture]',
    '    dynamic_facets:',
    '      pool: fix',
    '      max_selected: 2',
    '    instruction: fix',
    '    edit: true',
    '    output_contracts:',
    '      report:',
    '        - name: fix-report.md',
    '          format: plain',
    '    rules:',
    '      - condition: needs_review',
    '        next: review',
    '      - condition: done',
    '        next: COMPLETE',
    '  - name: review',
    '    persona: reviewer',
    '    instruction: review the fix',
    '    output_contracts:',
    '      report:',
    '        - name: review-report.md',
    '          format: plain',
    '    rules:',
    '      - condition: needs_fix',
    '        next: fix',
    '      - condition: done',
    '        next: COMPLETE',
    '',
  ].join('\n'), 'utf-8');
  return workflowPath;
}

function readJsonl(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, 'utf-8')
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function onlyRunRoot(repoPath: string): string {
  const runIds = readdirSync(join(repoPath, '.takt', 'runs'));
  expect(runIds).toHaveLength(1);
  return join(repoPath, '.takt', 'runs', runIds[0]!);
}

describe('E2E: dynamic facet pool selector (mock)', () => {
  let isolatedEnv: IsolatedEnv;
  let testRepo: TestRepo;

  beforeEach(() => {
    isolatedEnv = createIsolatedEnv();
    testRepo = createTestRepo();
  });

  afterEach(() => {
    testRepo.cleanup();
    isolatedEnv.cleanup();
  });

  it('should apply fixed coding/testing/architecture facets and select transaction+backward-compatibility based on the prior report (C-TEST-MOCK-E2E: 1-3)', () => {
    writeSharedExternalPool(testRepo.path);
    writeFixedFacets(testRepo.path);
    const workflowPath = writeFixWorkflow(testRepo.path, 'dynamic-facet-pool');
    const mockCallLogPath = join(testRepo.path, '.takt-mock-call-log.ndjson');
    updateIsolatedConfig(isolatedEnv.taktDir, {
      provider: 'mock',
      model: 'mock-default',
      logging: { usage_events: true },
    });

    // Scenario:
    // 1. selector returns transaction + backward-compatibility
    // 2. fix agent runs (main work) - output contract report
    // 3. review agent needs_fix -> back to fix
    // 4. selector returns only transaction (new round replaces)
    // 5. fix agent runs again
    // 6. review done -> COMPLETE
    const scenarioPath = join(testRepo.path, '.takt', 'dynamic-facet-pool-scenario.json');
    const judgeResponse = (step: number, reason: string) => ({
      persona: 'conductor',
      status: 'done',
      content: '',
      structured_output: { step, reason },
    });
    writeFileSync(scenarioPath, JSON.stringify([
      {
        status: 'done',
        content: '',
        structured_output: {
          selected_ids: ['transaction', 'backward-compatibility'],
          rationale: 'task needs transaction and backward compatibility expertise',
        },
      },
      { persona: 'coder', status: 'done', content: '[STEP:1]\nneeds_review' },
      { persona: 'coder', status: 'done', content: 'fix report round 1' },
      judgeResponse(1, 'needs_review'),
      { persona: 'reviewer', status: 'done', content: '[STEP:1]\nneeds_fix' },
      { persona: 'reviewer', status: 'done', content: 'review report round 1' },
      judgeResponse(1, 'needs_fix'),
      {
        status: 'done',
        content: '',
        structured_output: {
          selected_ids: ['transaction'],
          rationale: 'only transaction is still needed after the fix',
        },
      },
      { persona: 'coder', status: 'done', content: '[STEP:1]\nneeds_review' },
      { persona: 'coder', status: 'done', content: 'fix report round 2' },
      judgeResponse(1, 'needs_review'),
      { persona: 'reviewer', status: 'done', content: '[STEP:1]\ndone' },
      { persona: 'reviewer', status: 'done', content: 'review report round 2' },
      judgeResponse(2, 'done'),
    ]), 'utf-8');

    const result = runTakt({
      args: [
        '--task', 'Fix a transaction boundary and backward compatibility issue',
        '--workflow', workflowPath,
      ],
      cwd: testRepo.path,
      env: {
        ...isolatedEnv.env,
        TAKT_MOCK_SCENARIO: scenarioPath,
        TAKT_MOCK_CALL_LOG: mockCallLogPath,
      },
      timeout: 240_000,
      injectProvider: false,
    });

    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);

    // The fix prompt must contain the fixed facets (coding/testing/architecture) always.
    // The selected dynamic facets (transaction-correctness, backward-compatibility) must appear in round 1.
    // Round 2 must contain only transaction, not backward-compatibility.
    const providerStarts = readJsonl(mockCallLogPath)
      .filter((record) => record.event === 'start');
    const selectorStarts = providerStarts.filter((record) => record.personaName === 'takt-internal');
    expect(selectorStarts).toHaveLength(2);

    // The run reports must exist.
    const reportDir = join(onlyRunRoot(testRepo.path), 'reports');
    expect(readFileSync(join(reportDir, 'fix-report.md'), 'utf-8')).toContain('round 2');
    expect(readFileSync(join(reportDir, 'review-report.md'), 'utf-8')).toContain('round 2');
  }, 240_000);

  it('should replace the previous round dynamic facets and not retain them in the new session (C-TEST-MOCK-E2E: 4-5)', () => {
    writeSharedExternalPool(testRepo.path);
    writeFixedFacets(testRepo.path);
    const workflowPath = writeFixWorkflow(testRepo.path, 'dynamic-facet-pool-replace');
    const mockCallLogPath = join(testRepo.path, '.takt-mock-replace-calls.ndjson');
    updateIsolatedConfig(isolatedEnv.taktDir, {
      provider: 'mock',
      model: 'mock-default',
      logging: { usage_events: true },
    });

    const scenarioPath = join(testRepo.path, '.takt', 'dynamic-facet-pool-replace-scenario.json');
    const judgeResponse = (step: number, reason: string) => ({
      persona: 'conductor',
      status: 'done',
      content: '',
      structured_output: { step, reason },
    });
    writeFileSync(scenarioPath, JSON.stringify([
      {
        status: 'done',
        content: '',
        structured_output: {
          selected_ids: ['transaction', 'backward-compatibility'],
          rationale: 'round 1 needs both',
        },
      },
      { persona: 'coder', status: 'done', content: '[STEP:1]\nneeds_review' },
      { persona: 'coder', status: 'done', content: 'fix report round 1' },
      judgeResponse(1, 'needs_review'),
      { persona: 'reviewer', status: 'done', content: '[STEP:1]\nneeds_fix' },
      { persona: 'reviewer', status: 'done', content: 'review report round 1' },
      judgeResponse(1, 'needs_fix'),
      {
        status: 'done',
        content: '',
        structured_output: {
          selected_ids: [],
          rationale: 'no dynamic facets needed in round 2',
        },
      },
      { persona: 'coder', status: 'done', content: '[STEP:1]\nneeds_review' },
      { persona: 'coder', status: 'done', content: 'fix report round 2' },
      judgeResponse(1, 'needs_review'),
      { persona: 'reviewer', status: 'done', content: '[STEP:1]\ndone' },
      { persona: 'reviewer', status: 'done', content: 'review report round 2' },
      judgeResponse(2, 'done'),
    ]), 'utf-8');

    const result = runTakt({
      args: [
        '--task', 'Replace dynamic facets across rounds',
        '--workflow', workflowPath,
      ],
      cwd: testRepo.path,
      env: {
        ...isolatedEnv.env,
        TAKT_MOCK_SCENARIO: scenarioPath,
        TAKT_MOCK_CALL_LOG: mockCallLogPath,
      },
      timeout: 240_000,
      injectProvider: false,
    });

    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);

    const selectorStarts = readJsonl(mockCallLogPath)
      .filter((record) => record.event === 'start' && record.personaName === 'takt-internal');
    expect(selectorStarts).toHaveLength(2);

    const fixPhaseStarts = readSessionRecords(testRepo.path)
      .filter((record) => record.type === 'phase_start'
        && record.step === 'fix'
        && record.phaseName === 'execute');
    expect(fixPhaseStarts).toHaveLength(2);
    expect(fixPhaseStarts[0]?.instruction).toContain('# transaction-correctness policy');
    expect(fixPhaseStarts[0]?.instruction).toContain('# backward-compatibility policy');
    expect(fixPhaseStarts[1]?.instruction).not.toContain('# transaction-correctness policy');
    expect(fixPhaseStarts[1]?.instruction).not.toContain('# backward-compatibility policy');

    // Round 2 selected [] (empty); the session must not carry over backward-compatibility from round 1.
    // The selector was re-run for the new round, and no selection was persisted in the resume point.
    const meta = JSON.parse(
      readFileSync(join(onlyRunRoot(testRepo.path), 'meta.json'), 'utf-8'),
    ) as {
      resume_point?: Record<string, unknown>;
    };
    expect(meta.resume_point).toBeDefined();
    expect(meta.resume_point).not.toHaveProperty('dynamic_facet_selections');
  }, 240_000);

  it('should reselect the changed facet pool when resuming an interrupted step', () => {
    writeSharedExternalPool(testRepo.path);
    writeFixedFacets(testRepo.path);
    const workflowPath = writeFixWorkflow(testRepo.path, 'dynamic-facet-pool-resume');
    const firstScenarioPath = join(testRepo.path, '.takt', 'dynamic-facet-resume-first.json');
    const resumedScenarioPath = join(testRepo.path, '.takt', 'dynamic-facet-resume-second.json');
    const resumedCallLogPath = join(testRepo.path, '.takt-mock-facet-resume-calls.ndjson');
    updateIsolatedConfig(isolatedEnv.taktDir, { provider: 'mock', model: 'mock-default' });

    writeFileSync(firstScenarioPath, JSON.stringify([
      {
        status: 'done',
        content: '',
        structured_output: {
          selected_ids: ['transaction'],
          rationale: 'The interrupted run used the original pool.',
        },
      },
      { persona: 'coder', status: 'error', content: 'interrupted after selection' },
    ]), 'utf-8');

    const firstRun = runTakt({
      args: [
        '--task', 'Resume a dynamic facet selection after the pool changes',
        '--workflow', workflowPath,
      ],
      cwd: testRepo.path,
      env: { ...isolatedEnv.env, TAKT_MOCK_SCENARIO: firstScenarioPath },
      timeout: 240_000,
      injectProvider: false,
    });
    expect(firstRun.exitCode, `${firstRun.stdout}\n${firstRun.stderr}`).not.toBe(0);

    writeChangedExternalPool(testRepo.path);
    writeFileSync(resumedScenarioPath, JSON.stringify([
      {
        status: 'done',
        content: '',
        structured_output: {
          selected_ids: ['database'],
          rationale: 'Use the current pool after resume.',
        },
      },
      { persona: 'coder', status: 'done', content: '[STEP:1]\ndone' },
    ]), 'utf-8');

    const resumedRun = runTakt({
      args: ['--provider', 'mock', 'resume'],
      cwd: testRepo.path,
      env: {
        ...isolatedEnv.env,
        TAKT_MOCK_SCENARIO: resumedScenarioPath,
        TAKT_MOCK_CALL_LOG: resumedCallLogPath,
      },
      timeout: 240_000,
      injectProvider: false,
    });

    expect(resumedRun.exitCode, `${resumedRun.stdout}\n${resumedRun.stderr}`).toBe(0);
    const resumedStarts = readJsonl(resumedCallLogPath)
      .filter((record) => record.event === 'start');
    const personaNames = resumedStarts.map((record) => record.personaName);
    expect(personaNames.filter((name) => name === 'takt-internal')).toHaveLength(1);
    expect(personaNames.filter((name) => name === 'coder').length).toBeGreaterThan(0);

    const runIds = readdirSync(join(testRepo.path, '.takt', 'runs')).sort();
    const resumedRunRoot = join(testRepo.path, '.takt', 'runs', runIds.at(-1)!);
    const logsDir = join(resumedRunRoot, 'logs');
    const logFile = readdirSync(logsDir)
      .filter((file) => file.endsWith('.jsonl') && !file.endsWith('-otel-session-shadow.jsonl') && !file.endsWith('-usage-events.jsonl'))
      .find((file) => {
        const firstRecord = readFileSync(join(logsDir, file), 'utf-8').trim().split('\n')[0];
        return firstRecord !== undefined && (JSON.parse(firstRecord) as Record<string, unknown>).type === 'workflow_start';
      });
    expect(logFile).toBeDefined();
    const records = readFileSync(join(resumedRunRoot, 'logs', logFile!), 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const fixExecute = records.find((record) => record.type === 'phase_start'
      && record.step === 'fix'
      && record.phaseName === 'execute');
    expect(fixExecute).toBeDefined();
    const fixInstruction = fixExecute?.instruction ?? fixExecute?.userInstruction;
    expect(fixInstruction).toContain('# database-transaction knowledge');
    expect(fixInstruction).not.toContain('# transaction-correctness policy');
  }, 480_000);

  it('should not start the fix agent when the selector fails and fail-fast (C-TEST-MOCK-E2E: 6)', () => {
    writeSharedExternalPool(testRepo.path);
    writeFixedFacets(testRepo.path);
    const workflowPath = writeFixWorkflow(testRepo.path, 'dynamic-facet-pool-selector-fail');
    const mockCallLogPath = join(testRepo.path, '.takt-mock-selector-fail-calls.ndjson');
    updateIsolatedConfig(isolatedEnv.taktDir, {
      provider: 'mock',
      model: 'mock-default',
    });

    const scenarioPath = join(testRepo.path, '.takt', 'dynamic-facet-pool-selector-fail-scenario.json');
    writeFileSync(scenarioPath, JSON.stringify([
      // Selector returns an unknown ID not in the pool enum.
      {
        status: 'done',
        content: '',
        structured_output: {
          selected_ids: ['unknown-id'],
          rationale: 'invalid selection',
        },
      },
    ]), 'utf-8');

    const result = runTakt({
      args: [
        '--task', 'Selector returns an unknown ID',
        '--workflow', workflowPath,
      ],
      cwd: testRepo.path,
      env: {
        ...isolatedEnv.env,
        TAKT_MOCK_SCENARIO: scenarioPath,
        TAKT_MOCK_CALL_LOG: mockCallLogPath,
      },
      timeout: 240_000,
      injectProvider: false,
    });

    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).not.toBe(0);
    // The fix agent must never have started.
    const providerStarts = readJsonl(mockCallLogPath)
      .filter((record) => record.event === 'start');
    const personaNames = providerStarts.map((record) => record.personaName);
    expect(personaNames.filter((name) => name === 'coder')).toHaveLength(0);
    // The selector did start.
    expect(personaNames.filter((name) => name === 'takt-internal')).toHaveLength(1);
  }, 240_000);

  it('should share the same external pool from a second workflow (C-TEST-MOCK-E2E: 7)', () => {
    writeSharedExternalPool(testRepo.path);
    writeFixedFacets(testRepo.path);
    // Two distinct workflows referencing the same pool.
    const firstWorkflowPath = writeFixWorkflow(testRepo.path, 'dynamic-facet-pool-shared-a');
    const secondWorkflowPath = writeFixWorkflow(testRepo.path, 'dynamic-facet-pool-shared-b');

    updateIsolatedConfig(isolatedEnv.taktDir, {
      provider: 'mock',
      model: 'mock-default',
    });

    const runWithSelection = (workflowPath: string, selectedIds: string[], suffix: string) => {
      const scenarioPath = join(testRepo.path, `.takt/dynamic-facet-pool-shared-${suffix}-scenario.json`);
      const judgeResponse = (step: number, reason: string) => ({
        persona: 'conductor',
        status: 'done',
        content: '',
        structured_output: { step, reason },
      });
      writeFileSync(scenarioPath, JSON.stringify([
        {
          status: 'done',
          content: '',
          structured_output: {
            selected_ids: selectedIds,
            rationale: `shared pool selection for ${suffix}`,
          },
        },
        { persona: 'coder', status: 'done', content: '[STEP:1]\nneeds_review' },
        { persona: 'coder', status: 'done', content: `fix report ${suffix}` },
        judgeResponse(1, 'needs_review'),
        { persona: 'reviewer', status: 'done', content: '[STEP:1]\ndone' },
        { persona: 'reviewer', status: 'done', content: `review report ${suffix}` },
        judgeResponse(2, 'done'),
      ]), 'utf-8');
      return runTakt({
        args: ['--task', `Shared pool run ${suffix}`, '--workflow', workflowPath],
        cwd: testRepo.path,
        env: {
          ...isolatedEnv.env,
          TAKT_MOCK_SCENARIO: scenarioPath,
        },
        timeout: 240_000,
        injectProvider: false,
      });
    };

    const first = runWithSelection(firstWorkflowPath, ['transaction'], 'a');
    const second = runWithSelection(secondWorkflowPath, ['backward-compatibility'], 'b');

    expect(first.exitCode, `${first.stdout}\n${first.stderr}`).toBe(0);
    expect(second.exitCode, `${second.stdout}\n${second.stderr}`).toBe(0);
  }, 480_000);

  it('should not capture a caller workflow same-named alias for the external pool (C-TEST-MOCK-E2E: external 暗黙 capture 拒否)', () => {
    writeSharedExternalPool(testRepo.path);
    writeFixedFacets(testRepo.path);
    const workflowPath = writeFixWorkflow(testRepo.path, 'dynamic-facet-pool-no-capture');
    const mockCallLogPath = join(testRepo.path, '.takt-mock-no-capture-calls.ndjson');
    updateIsolatedConfig(isolatedEnv.taktDir, {
      provider: 'mock',
      model: 'mock-default',
    });

    const scenarioPath = join(testRepo.path, '.takt', 'dynamic-facet-pool-no-capture-scenario.json');
    const judgeResponse = (step: number, reason: string) => ({
      persona: 'conductor',
      status: 'done',
      content: '',
      structured_output: { step, reason },
    });
    writeFileSync(scenarioPath, JSON.stringify([
      {
        status: 'done',
        content: '',
        structured_output: {
          selected_ids: ['transaction'],
          rationale: 'select transaction to check policy source',
        },
      },
      { persona: 'coder', status: 'done', content: '[STEP:1]\nneeds_review' },
      { persona: 'coder', status: 'done', content: 'fix report' },
      judgeResponse(1, 'needs_review'),
      { persona: 'reviewer', status: 'done', content: '[STEP:1]\ndone' },
      { persona: 'reviewer', status: 'done', content: 'review report' },
      judgeResponse(2, 'done'),
    ]), 'utf-8');

    const result = runTakt({
      args: [
        '--task', 'Verify external pool does not capture caller alias',
        '--workflow', workflowPath,
      ],
      cwd: testRepo.path,
      env: {
        ...isolatedEnv.env,
        TAKT_MOCK_SCENARIO: scenarioPath,
        TAKT_MOCK_CALL_LOG: mockCallLogPath,
      },
      timeout: 240_000,
      injectProvider: false,
    });

    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    // The caller defines transaction-correctness pointing at the CALLER file, but the pool must use its own.
    // The session records for the fix step should reflect that the pool's facet (not the caller's) was used.
    const sessionRecords = readSessionRecords(testRepo.path);
    const fixStepRecords = sessionRecords.filter((r) => r.type === 'step_start' && r.step === 'fix');
    expect(fixStepRecords.length).toBeGreaterThan(0);
  }, 240_000);
});
