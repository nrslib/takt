import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createIsolatedEnv, type IsolatedEnv, updateIsolatedConfig } from '../helpers/isolated-env';
import { runTakt } from '../helpers/takt-runner';
import { createTestRepo, type TestRepo } from '../helpers/test-repo';
import { readSessionRecords } from '../helpers/session-log';

function writeDynamicParallelFixture(
  repoPath: string,
  selectedIds: readonly string[] = ['frontend'],
): { workflowPath: string; scenarioPath: string } {
  const workflowDir = join(repoPath, '.takt', 'workflows');
  const agentsDir = join(workflowDir, 'agents');
  mkdirSync(agentsDir, { recursive: true });
  for (const name of ['architecture', 'frontend', 'backend']) {
    writeFileSync(join(agentsDir, `${name}.md`), `You are the ${name} reviewer.\n`, 'utf-8');
  }

  const workflowPath = join(workflowDir, 'dynamic-parallel-selector.yaml');
  writeFileSync(workflowPath, [
    'name: dynamic-parallel-selector',
    'initial_step: reviewers',
    'max_steps: 1',
    'steps:',
    '  - name: reviewers',
    '    parallel:',
    '      fixed:',
    '        - name: architecture',
    '          persona: ./agents/architecture.md',
    '          instruction: Review architecture',
    '          rules:',
    '            - condition: approved',
    '      pool:',
    '        - name: frontend',
    '          persona: ./agents/frontend.md',
    '          description: Review frontend changes',
    '          instruction: Review frontend',
    '          rules:',
    '            - condition: approved',
        '        - name: backend',
        '          persona: ./agents/backend.md',
        '          model: mock-backend-unselected',
        '          description: Review backend changes',
    '          instruction: Review backend',
    '          rules:',
    '            - condition: approved',
    '    rules:',
    '      - condition: all("approved")',
    '        next: COMPLETE',
    '',
  ].join('\n'), 'utf-8');

  const scenarioPath = join(repoPath, '.takt', 'dynamic-parallel-selector-scenario.json');
  writeFileSync(scenarioPath, JSON.stringify([
    {
      status: 'done',
      content: '',
      structured_output: {
        selected_ids: selectedIds,
        rationale: 'The task changes the frontend.',
      },
    },
    { status: 'done', content: 'approved' },
    { status: 'done', content: 'approved' },
    { status: 'done', content: 'approved' },
  ]), 'utf-8');

  return { workflowPath, scenarioPath };
}

function writeReentryFixture(
  repoPath: string,
  mode: 'replace' | 'cumulative',
): { workflowPath: string; scenarioPath: string } {
  const workflowDir = join(repoPath, '.takt', 'workflows');
  const agentsDir = join(workflowDir, 'agents');
  mkdirSync(agentsDir, { recursive: true });
  for (const name of ['architecture', 'frontend', 'backend', 'fix']) {
    writeFileSync(join(agentsDir, `${name}.md`), `You are the ${name} agent.\n`, 'utf-8');
  }

  const workflowPath = join(workflowDir, `dynamic-parallel-${mode}.yaml`);
  writeFileSync(workflowPath, [
    `name: e2e-dynamic-parallel-${mode}`,
    'initial_step: reviewers',
    'max_steps: 5',
    'report_formats:',
    '  review: Return the current reviewer report.',
    'steps:',
    '  - name: reviewers',
    '    parallel:',
    '      fixed:',
    '        - name: architecture',
    '          persona: ./agents/architecture.md',
    '          instruction: Review architecture',
    '          output_contracts:',
    '            report:',
    '              - name: architecture-review.md',
    '                format: review',
    '          rules:',
    '            - condition: approved',
    '            - condition: needs_fix',
    '      pool:',
    '        - name: frontend',
    '          persona: ./agents/frontend.md',
    '          description: Review frontend changes',
    '          instruction: Review frontend',
    '          output_contracts:',
    '            report:',
    '              - name: frontend-review.md',
    '                format: review',
    '          rules:',
    '            - condition: approved',
    '            - condition: needs_fix',
    '        - name: backend',
    '          persona: ./agents/backend.md',
    '          description: Review backend changes',
    '          instruction: Review backend',
    '          output_contracts:',
    '            report:',
    '              - name: backend-review.md',
    '                format: review',
    '          rules:',
    '            - condition: approved',
    '            - condition: needs_fix',
    '      selection:',
    `        mode: ${mode}`,
    '    rules:',
    '      - condition: any("needs_fix")',
    '        next: fix',
    '      - condition: all("approved")',
    '        next: COMPLETE',
    '  - name: fix',
    '    persona: ./agents/fix.md',
    '    instruction: Fix the reported issue',
    '    rules:',
    '      - condition: approved',
    '        next: reviewers',
    '',
  ].join('\n'), 'utf-8');
  const scenarioPath = join(repoPath, `.takt/dynamic-parallel-${mode}-scenario.json`);
  const judgeResponse = (step: number, reason: string) => ({
    persona: 'conductor',
    status: 'done',
    content: '',
    structured_output: { step, reason },
  });
  const followUpFrontend = mode === 'cumulative'
    ? [
        { persona: 'agents/frontend', status: 'done', content: '[STEP:1]\napproved' },
        { persona: 'agents/frontend', status: 'done', content: 'frontend report after follow-up review' },
        judgeResponse(1, 'Frontend follow-up review approved.'),
      ]
    : [];
  const followUpBackend = mode === 'cumulative'
    ? [
        { persona: 'agents/backend', status: 'done', content: '[STEP:2]\nneeds_fix' },
        { persona: 'agents/backend', status: 'done', content: 'backend report requiring another fix' },
        judgeResponse(2, 'Backend follow-up review needs a fix.'),
      ]
    : [
        { persona: 'agents/backend', status: 'done', content: '[STEP:1]\napproved' },
        { persona: 'agents/backend', status: 'done', content: 'backend report after follow-up review' },
        judgeResponse(1, 'Backend follow-up review approved.'),
      ];
  const cumulativeShrinkRound = mode === 'cumulative'
    ? [
        { persona: 'agents/fix', status: 'done', content: 'approved' },
        { status: 'done', content: '', structured_output: { selected_ids: [], rationale: 'No pool reviewer is newly required.' } },
        { persona: 'agents/architecture', status: 'done', content: '[STEP:1]\napproved' },
        { persona: 'agents/architecture', status: 'done', content: 'architecture report after shrink selection' },
        judgeResponse(1, 'Architecture shrink-round review approved.'),
        { persona: 'agents/frontend', status: 'done', content: '[STEP:1]\napproved' },
        { persona: 'agents/frontend', status: 'done', content: 'frontend report after shrink selection' },
        judgeResponse(1, 'Frontend shrink-round review approved.'),
        { persona: 'agents/backend', status: 'done', content: '[STEP:1]\napproved' },
        { persona: 'agents/backend', status: 'done', content: 'backend report after shrink selection' },
        judgeResponse(1, 'Backend shrink-round review approved.'),
      ]
    : [];
  writeFileSync(scenarioPath, JSON.stringify([
    { status: 'done', content: '', structured_output: { selected_ids: ['frontend'], rationale: 'Initial frontend review.' } },
    { persona: 'agents/architecture', status: 'done', content: '[STEP:1]\napproved' },
    { persona: 'agents/architecture', status: 'done', content: 'architecture report after initial review' },
    judgeResponse(1, 'Architecture review approved.'),
    { persona: 'agents/frontend', status: 'done', content: '[STEP:2]\nneeds_fix' },
    { persona: 'agents/frontend', status: 'done', content: 'frontend report after initial review' },
    judgeResponse(2, 'Frontend review needs a fix.'),
    { persona: 'agents/fix', status: 'done', content: 'approved' },
    { status: 'done', content: '', structured_output: { selected_ids: ['backend'], rationale: 'Follow-up backend review.' } },
    { persona: 'agents/architecture', status: 'done', content: '[STEP:1]\napproved' },
    { persona: 'agents/architecture', status: 'done', content: 'architecture report after follow-up review' },
    judgeResponse(1, 'Architecture follow-up review approved.'),
    ...followUpFrontend,
    ...followUpBackend,
    ...cumulativeShrinkRound,
  ]), 'utf-8');
  return { workflowPath, scenarioPath };
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

function writeSelectedArtifactsFixture(repoPath: string): { workflowPath: string; scenarioPath: string } {
  const workflowDir = join(repoPath, '.takt', 'workflows');
  const agentsDir = join(workflowDir, 'agents');
  mkdirSync(agentsDir, { recursive: true });
  for (const name of ['architecture', 'frontend', 'backend', 'fix', 'findings-manager']) {
    writeFileSync(join(agentsDir, `${name}.md`), `You are the ${name} agent.\n`, 'utf-8');
  }

  const reportContract = [
    '          output_contracts:',
    '            report:',
    '              - name: REPORT_NAME',
    '                format: review-finding-contract',
  ];
  const reviewer = (name: string, description?: string) => [
    `        - name: ${name}`,
    `          persona: ./agents/${name}.md`,
    ...(description === undefined ? [] : [`          description: ${description}`]),
    `          instruction: Review ${name}`,
    ...reportContract.map((line) => line.replace('REPORT_NAME', `${name}-review.md`)),
    '          rules:',
    '            - condition: approved',
    '            - condition: needs_fix',
  ];
  const workflowPath = join(workflowDir, 'dynamic-parallel-selected-artifacts.yaml');
  writeFileSync(workflowPath, [
    'name: e2e-dynamic-parallel-selected-artifacts',
    'initial_step: reviewers',
    'max_steps: 5',
    'instructions:',
    '  findings-manager: Reconcile raw findings.',
    'report_formats:',
    '  review-finding-contract: Return a concise E2E review report.',
    '  findings-manager: Return the finding manager JSON contract.',
    'finding_contract:',
    '  ledger_path: .takt/findings/peer-review.json',
    '  raw_findings_path: .takt/findings/raw',
    '  manager:',
    '    persona: ./agents/findings-manager.md',
    '    instruction: findings-manager',
    '    output_contract: findings-manager',
    'steps:',
    '  - name: reviewers',
    '    parallel:',
    '      fixed:',
    ...reviewer('architecture'),
    '      pool:',
    ...reviewer('frontend', 'Review frontend changes'),
    ...reviewer('backend', 'Review backend changes'),
    '      selection:',
    '        mode: replace',
    '    rules:',
    '      - condition: any("needs_fix")',
    '        next: fix',
    '      - condition: all("approved")',
    '        next: COMPLETE',
    '  - name: fix',
    '    persona: ./agents/fix.md',
    '    instruction: Fix the reported issue',
    '    rules:',
    '      - condition: approved',
    '        next: reviewers',
    '',
  ].join('\n'), 'utf-8');

  const rawFinding = (id: string) => {
    const rawExcerpt = `${id} observed a selected-only finding.`;
    return {
      rawExcerpt,
      candidate: {
        rawFindingId: id,
        familyTag: 'selected-only',
        severity: 'low',
        title: `${id} finding`,
        description: rawExcerpt,
        suggestion: 'Keep the selected reviewer evidence.',
        relation: 'new',
        targetFindingIds: [],
        target: { kind: 'code', paths: [`fixtures/${id}.ts`] },
        evidenceRequests: [],
      },
    };
  };
  const executeResponse = (persona: string, content: string) => ({
    persona: `agents/${persona}`,
    status: 'done',
    content,
  });
  const reportResponse = (persona: string, id: string, round: number) => {
    const finding = rawFinding(id);
    return {
      persona: `agents/${persona}`,
      status: 'done',
      content: '',
      structured_output: {
        reportContent: `${persona} report for round ${round}\n${finding.rawExcerpt}`,
        rawFindings: [finding],
      },
    };
  };
  const judgeResponse = (step: number) => ({
    persona: 'conductor',
    status: 'done',
    content: '',
    structured_output: { step, reason: 'E2E status' },
  });
  const managerResponse = {
    persona: 'agents/findings-manager',
    status: 'done',
    content: 'Manager left the findings unresolved for the final gate.',
    structured_output: {
      taskId: 'intentionally-unmatched-e2e-task',
      decisions: [],
    },
  };
  const scenarioPath = join(repoPath, '.takt', 'dynamic-parallel-selected-artifacts-scenario.json');
  writeFileSync(scenarioPath, JSON.stringify([
    { status: 'done', content: '', structured_output: { selected_ids: ['frontend'], rationale: 'Initial frontend review.' } },
    executeResponse('architecture', 'approved'),
    reportResponse('architecture', 'architecture-round-1', 1),
    judgeResponse(1),
    executeResponse('frontend', 'needs_fix'),
    reportResponse('frontend', 'frontend-round-1', 1),
    judgeResponse(2),
    managerResponse,
    { persona: 'agents/fix', status: 'done', content: 'approved' },
    { status: 'done', content: '', structured_output: { selected_ids: ['backend'], rationale: 'Follow-up backend review.' } },
    executeResponse('architecture', 'approved'),
    reportResponse('architecture', 'architecture-round-2', 2),
    judgeResponse(1),
    executeResponse('backend', 'approved'),
    reportResponse('backend', 'backend-round-2', 2),
    judgeResponse(1),
    managerResponse,
  ]), 'utf-8');

  return { workflowPath, scenarioPath };
}

describe('E2E: dynamic parallel selector (mock)', () => {
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

  it('should execute the fixed reviewer and selected frontend reviewer without starting the backend reviewer', () => {
    const { workflowPath, scenarioPath } = writeDynamicParallelFixture(testRepo.path);
    const mockCallLogPath = join(testRepo.path, '.takt-mock-call-log.ndjson');
    updateIsolatedConfig(isolatedEnv.taktDir, {
      provider: 'mock',
      model: 'mock-default',
      logging: { usage_events: true },
    });

    const result = runTakt({
      args: [
        '--task', 'Review a frontend change',
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
    expect(result.stdout).toContain('[architecture]');
    expect(result.stdout).toContain('[frontend]');
    expect(result.stdout).not.toContain('[backend]');
    const providerStarts = readJsonl(mockCallLogPath)
      .filter((record) => record.event === 'start');
    expect(providerStarts).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'mock', personaName: 'agents/architecture' }),
      expect.objectContaining({ provider: 'mock', personaName: 'agents/frontend' }),
    ]));
    expect(providerStarts.some((record) => record.personaName === 'agents/backend')).toBe(false);
    expect(providerStarts.some((record) => record.model === 'mock-backend-unselected')).toBe(false);

    const sessionRecords = readSessionRecords(testRepo.path);
    expect(sessionRecords.some((record) => record.type === 'step_start' && record.step === 'backend')).toBe(false);

    const logsDirectory = join(onlyRunRoot(testRepo.path), 'logs');
    const usageFile = readdirSync(logsDirectory).find((file) => file.endsWith('-usage-events.jsonl'));
    expect(usageFile).toBeDefined();
    const usageRecords = readJsonl(join(logsDirectory, usageFile!));
    expect(usageRecords).toEqual(expect.arrayContaining([
      expect.objectContaining({
        step: expect.stringMatching(/^dynamic-selector:/),
        provider: 'mock',
        provider_model: 'mock-default',
      }),
    ]));
    expect(usageRecords.some((record) => record.step === 'backend')).toBe(false);
  }, 240_000);

  it('should apply one CLI selector override to prompt, doctor, and runtime entry points', () => {
    const { workflowPath, scenarioPath } = writeDynamicParallelFixture(testRepo.path);
    const mockCallLogPath = join(testRepo.path, '.takt-mock-cli-override-calls.ndjson');
    writeFileSync(join(testRepo.path, '.takt', 'config.yaml'), [
      'provider: mock',
      'model: project-default',
      'takt_providers:',
      '  selector:',
      '    provider: opencode',
      '    model: opencode/project-selector',
    ].join('\n'), 'utf-8');
    const cliOverride = ['--provider', 'mock', '--model', 'cli-selector-model'];
    const commandEnv = {
      ...isolatedEnv.env,
      TAKT_MOCK_SCENARIO: scenarioPath,
      TAKT_MOCK_CALL_LOG: mockCallLogPath,
    };

    const prompt = runTakt({
      args: [...cliOverride, 'prompt', workflowPath],
      cwd: testRepo.path,
      env: commandEnv,
      timeout: 60_000,
      injectProvider: false,
    });
    const doctor = runTakt({
      args: [...cliOverride, 'workflow', 'doctor', workflowPath],
      cwd: testRepo.path,
      env: commandEnv,
      timeout: 60_000,
      injectProvider: false,
    });
    const runtime = runTakt({
      args: [
        ...cliOverride,
        '--task', 'Review a frontend change',
        '--workflow', workflowPath,
      ],
      cwd: testRepo.path,
      env: commandEnv,
      timeout: 240_000,
      injectProvider: false,
    });
    const withoutOverride = runTakt({
      args: ['workflow', 'doctor', workflowPath],
      cwd: testRepo.path,
      env: commandEnv,
      timeout: 60_000,
      injectProvider: false,
    });

    expect(prompt.exitCode, `${prompt.stdout}\n${prompt.stderr}`).toBe(0);
    expect(prompt.stdout).toContain('Dynamic selector provider: mock');
    expect(prompt.stdout).toContain('Dynamic selector model: cli-selector-model');
    expect(doctor.exitCode, `${doctor.stdout}\n${doctor.stderr}`).toBe(0);
    expect(runtime.exitCode, `${runtime.stdout}\n${runtime.stderr}`).toBe(0);
    const selectorStarts = readJsonl(mockCallLogPath)
      .filter((record) => record.event === 'start' && record.personaName === 'takt-internal');
    expect(selectorStarts).toEqual([
      expect.objectContaining({ provider: 'mock', model: 'cli-selector-model' }),
    ]);
    expect(withoutOverride.exitCode).toBe(1);
    expect(`${withoutOverride.stdout}\n${withoutOverride.stderr}`)
      .toContain('does not support strict internal-agent isolation');
  }, 420_000);

  it('should execute selected pool reviewers in YAML order when the selector returns them in reverse order', () => {
    const { workflowPath, scenarioPath } = writeDynamicParallelFixture(testRepo.path, ['backend', 'frontend']);
    updateIsolatedConfig(isolatedEnv.taktDir, { provider: 'mock', model: 'mock-default' });

    const result = runTakt({
      args: ['--task', 'Review frontend and backend changes', '--workflow', workflowPath],
      cwd: testRepo.path,
      env: { ...isolatedEnv.env, TAKT_MOCK_SCENARIO: scenarioPath },
      timeout: 240_000,
      injectProvider: false,
    });

    expect(result.exitCode, result.stderr).toBe(0);
    const architecture = result.stdout.indexOf('[architecture]');
    const frontend = result.stdout.indexOf('[frontend]');
    const backend = result.stdout.indexOf('[backend]');
    expect(architecture).toBeGreaterThanOrEqual(0);
    expect(frontend).toBeGreaterThan(architecture);
    expect(backend).toBeGreaterThan(frontend);
  }, 240_000);

  it.each([
    ['replace', { architecture: 2, frontend: 1, backend: 1, selectors: 2 }],
    ['cumulative', { architecture: 3, frontend: 3, backend: 2, selectors: 3 }],
  ] as const)('should apply %s selection when reviewers re-enter after a fix', (mode, expected) => {
    const { workflowPath, scenarioPath } = writeReentryFixture(testRepo.path, mode);
    const mockCallLogPath = join(testRepo.path, `.takt-mock-${mode}-calls.ndjson`);

    const result = runTakt({
      args: ['--task', 'Review a frontend change and its backend fix', '--workflow', workflowPath, '--provider', 'mock'],
      cwd: testRepo.path,
      env: {
        ...isolatedEnv.env,
        TAKT_MOCK_SCENARIO: scenarioPath,
        TAKT_MOCK_CALL_LOG: mockCallLogPath,
      },
      timeout: 240_000,
    });

    expect(result.exitCode, result.stderr).toBe(0);
    const providerStarts = readJsonl(mockCallLogPath)
      .filter((record) => record.event === 'start');
    const personaStartCount = (personaName: string) =>
      providerStarts.filter((record) => record.personaName === personaName).length;
    expect(personaStartCount('agents/architecture')).toBe(expected.architecture * 2);
    expect(personaStartCount('agents/frontend')).toBe(expected.frontend * 2);
    expect(personaStartCount('agents/backend')).toBe(expected.backend * 2);
    const selectorStarts = providerStarts
      .filter((record) => record.personaName === 'takt-internal');
    expect(selectorStarts).toHaveLength(expected.selectors);
    if (mode === 'cumulative') {
      const meta = JSON.parse(
        readFileSync(join(onlyRunRoot(testRepo.path), 'meta.json'), 'utf-8'),
      ) as {
        resume_point?: {
          dynamic_parallel_selections?: Record<string, {
            round: number;
            selected_pool_ids: string[];
            effective_selection_ids: string[];
          }>;
        };
      };
      const selections = Object.values(meta.resume_point?.dynamic_parallel_selections ?? {});
      expect(selections).toEqual([
        expect.objectContaining({
          round: 3,
          selected_pool_ids: ['frontend', 'backend'],
          effective_selection_ids: ['architecture', 'frontend', 'backend'],
        }),
      ]);
    }
  }, 240_000);

  it('should resume with the saved selection without invoking the selector again', () => {
    const { workflowPath } = writeDynamicParallelFixture(testRepo.path);
    const firstScenarioPath = join(testRepo.path, '.takt', 'dynamic-parallel-resume-first.json');
    const resumedScenarioPath = join(testRepo.path, '.takt', 'dynamic-parallel-resume-second.json');
    const resumedCallLogPath = join(testRepo.path, '.takt-mock-resume-calls.ndjson');
    writeFileSync(join(testRepo.path, '.takt', 'config.yaml'), [
      'provider: mock',
      'model: project-default',
      'takt_providers:',
      '  selector:',
      '    provider: opencode',
      '    model: opencode/project-selector',
    ].join('\n'), 'utf-8');
    writeFileSync(firstScenarioPath, JSON.stringify([
      {
        status: 'done',
        content: '',
        structured_output: {
          selected_ids: ['frontend'],
          rationale: 'The task changes the frontend.',
        },
      },
      { persona: 'agents/architecture', status: 'done', content: 'approved' },
      { persona: 'agents/frontend', status: 'error', content: 'interrupted after selection' },
      { persona: 'agents/frontend', status: 'error', content: 'interrupted after selection' },
      { persona: 'agents/frontend', status: 'error', content: 'interrupted after selection' },
      { persona: 'agents/frontend', status: 'error', content: 'interrupted after selection' },
      { persona: 'agents/frontend', status: 'error', content: 'interrupted after selection' },
    ]), 'utf-8');
    writeFileSync(resumedScenarioPath, JSON.stringify([
      { persona: 'agents/architecture', status: 'done', content: 'approved' },
      { persona: 'agents/frontend', status: 'done', content: 'approved' },
    ]), 'utf-8');

    const firstRun = runTakt({
      args: [
        '--task', 'Review a frontend change',
        '--workflow', workflowPath,
        '--provider', 'mock',
        '--model', 'cli-resume-model',
      ],
      cwd: testRepo.path,
      env: { ...isolatedEnv.env, TAKT_MOCK_SCENARIO: firstScenarioPath },
      timeout: 240_000,
    });
    expect(firstRun.exitCode, `${firstRun.stdout}\n${firstRun.stderr}`).not.toBe(0);

    const resumedRun = runTakt({
      args: ['--provider', 'mock', '--model', 'cli-resume-model', 'resume'],
      cwd: testRepo.path,
      env: {
        ...isolatedEnv.env,
        TAKT_MOCK_SCENARIO: resumedScenarioPath,
        TAKT_MOCK_CALL_LOG: resumedCallLogPath,
      },
      timeout: 240_000,
    });

    expect(resumedRun.exitCode, `${resumedRun.stdout}\n${resumedRun.stderr}`).toBe(0);
    const resumedStarts = readJsonl(resumedCallLogPath)
      .filter((record) => record.event === 'start');
    const personaNames = resumedStarts.map((record) => record.personaName);
    expect(personaNames).toHaveLength(2);
    expect(personaNames.filter((name) => name === 'agents/architecture')).toHaveLength(1);
    expect(personaNames.filter((name) => name === 'agents/frontend')).toHaveLength(1);
    expect(personaNames.filter((name) => name === 'agents/backend')).toHaveLength(0);
    expect(personaNames.filter((name) => name === 'takt-internal')).toHaveLength(0);
    expect(resumedStarts.every((record) => record.model === 'cli-resume-model')).toBe(true);
  }, 480_000);

  it('should retain selected-only reports, raw findings, ledger records, and usage across replace rounds before the finding gate', () => {
    const { workflowPath, scenarioPath } = writeSelectedArtifactsFixture(testRepo.path);
    updateIsolatedConfig(isolatedEnv.taktDir, {
      provider: 'mock',
      model: 'mock-default',
      concurrency: 1,
      logging: { usage_events: true },
    });

    const result = runTakt({
      args: ['--task', 'Review frontend then backend changes', '--workflow', workflowPath, '--provider', 'mock'],
      cwd: testRepo.path,
      env: { ...isolatedEnv.env, TAKT_MOCK_SCENARIO: scenarioPath },
      timeout: 240_000,
    });

    expect(result.exitCode).toBe(1);

    const reportDir = join(onlyRunRoot(testRepo.path), 'reports');
    expect(readFileSync(join(reportDir, 'architecture-review.md'), 'utf-8')).toContain('round 2');
    expect(readFileSync(join(reportDir, 'frontend-review.md'), 'utf-8')).toContain('round 1');
    expect(readFileSync(join(reportDir, 'backend-review.md'), 'utf-8')).toContain('round 2');
    const historyDirectory = join(reportDir, '.takt-report-internal', 'history');
    const historyContents = readdirSync(historyDirectory, { recursive: true })
      .filter((entry) => typeof entry === 'string')
      .map((entry) => join(historyDirectory, entry))
      .filter((path) => statSync(path).isFile())
      .map((path) => readFileSync(path, 'utf-8'));
    expect(historyContents.filter((content) => content.includes('architecture report for round 1'))).toHaveLength(1);
    expect(historyContents.some((content) => content.includes('frontend report'))).toBe(false);
    expect(historyContents.some((content) => content.includes('backend report'))).toBe(false);

    const rawDirectory = join(testRepo.path, '.takt', 'findings', 'raw');
    const rawBatches = readdirSync(rawDirectory)
      .map((file) => JSON.parse(readFileSync(join(rawDirectory, file), 'utf-8')) as Array<{ reviewer: string }>);
    expect(rawBatches).toHaveLength(2);
    const firstRoundRaw = rawBatches.find((batch) => batch.some((finding) => finding.reviewer === 'frontend'));
    const secondRoundRaw = rawBatches.find((batch) => batch.some((finding) => finding.reviewer === 'backend'));
    expect(firstRoundRaw?.map((finding) => finding.reviewer).sort()).toEqual(['architecture', 'frontend']);
    expect(secondRoundRaw?.map((finding) => finding.reviewer).sort()).toEqual(['architecture', 'backend']);

    const ledger = JSON.parse(readFileSync(join(testRepo.path, '.takt', 'findings', 'peer-review.json'), 'utf-8')) as {
      rawFindings: Array<{ reviewer: string }>;
    };
    expect(ledger.rawFindings.map((finding) => finding.reviewer).sort())
      .toEqual(['architecture', 'architecture', 'backend', 'frontend']);

    const logsDirectory = join(onlyRunRoot(testRepo.path), 'logs');
    const usageFile = readdirSync(logsDirectory).find((file) => file.endsWith('-usage-events.jsonl'));
    expect(usageFile).toBeDefined();
    const usageSteps = readJsonl(join(logsDirectory, usageFile!))
      .filter((record) => record.step_type === 'parallel')
      .map((record) => record.step);
    const selectorIndexes = usageSteps
      .map((step, index) => step.startsWith('dynamic-selector:') ? index : -1)
      .filter((index) => index >= 0);
    expect(selectorIndexes).toHaveLength(2);
    const firstRoundUsage = usageSteps.slice(selectorIndexes[0]! + 1, selectorIndexes[1]!);
    const secondRoundUsage = usageSteps.slice(selectorIndexes[1]! + 1);
    expect(firstRoundUsage).toEqual(expect.arrayContaining(['architecture', 'frontend']));
    expect(firstRoundUsage).not.toContain('backend');
    expect(secondRoundUsage).toEqual(expect.arrayContaining(['architecture', 'backend']));
    expect(secondRoundUsage).not.toContain('frontend');
  }, 240_000);
});
