import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createIsolatedEnv, type IsolatedEnv } from '../helpers/isolated-env';
import { runTakt } from '../helpers/takt-runner';
import { createLocalRepo, type LocalRepo } from '../helpers/test-repo';
import { readSessionRecords } from '../helpers/session-log';

type JsonRecord = Record<string, unknown>;

function readJsonl(path: string): JsonRecord[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as JsonRecord);
}

function readJsonlDirectory(path: string): JsonRecord[] {
  return readdirSync(path)
    .filter((file) => file.endsWith('.jsonl'))
    .sort()
    .flatMap((file) => readJsonl(join(path, file)));
}

function expectSuccessfulParentCompanionCompletion(events: readonly JsonRecord[]): void {
  const completionEvents = events.filter((event) => (
    event.type === 'companion'
    && event.action === 'complete'
    && event.step === 'implement'
  ));
  expect(completionEvents).toEqual([
    expect.objectContaining({
      type: 'companion',
      action: 'complete',
      step: 'implement',
      completionSettled: true,
      completionFailure: false,
      followUpRounds: 1,
    }),
  ]);
}

function expectSingleFixPrompt(
  records: readonly JsonRecord[],
  personaName: string,
  promptNumber: number,
): void {
  const prompts = records.filter((record) => record.personaName === personaName);
  expect(prompts).toHaveLength(promptNumber);
  const prompt = prompts[promptNumber - 1]?.prompt;
  expect(prompt).toEqual(expect.any(String));
  expect(prompt).toContain('The exported value must not be negative.');
  expect(prompt).toContain('advisory reference information');
  expect(prompt).toContain('decide independently');
  expect(prompt).toContain('Minor, trivial, or unnecessary findings may be left unaddressed');
}

describe('E2E: companion review', () => {
  let isolatedEnv: IsolatedEnv;
  let repo: LocalRepo;
  let cloneRoot: string;
  let cloneDir: string;

  beforeEach(() => {
    isolatedEnv = createIsolatedEnv();
    repo = createLocalRepo();
    cloneRoot = mkdtempSync(join(tmpdir(), 'takt-companion-e2e-clone-'));
    cloneDir = join(cloneRoot, 'clone');
  });

  afterEach(() => {
    repo.cleanup();
    rmSync(cloneRoot, { recursive: true, force: true });
    isolatedEnv.cleanup();
  });

  it.each([
    {
      name: 'should explicitly loop to re-review a same-session fix and resolve the mailbox finding',
      fixPolicy: 'loop' as const,
      expectedReviewerStarts: 2,
    },
    {
      name: 'should default to one same-session fix without re-reviewing it',
      fixPolicy: undefined,
      expectedReviewerStarts: 1,
    },
  ])('$name', ({ fixPolicy, expectedReviewerStarts }) => {
    const workflowDir = join(repo.path, '.takt', 'workflows');
    const companionDir = join(repo.path, '.takt', 'companions');
    const analyticsEventsDir = join(isolatedEnv.taktDir, 'companion-analytics');
    mkdirSync(workflowDir, { recursive: true });
    mkdirSync(companionDir, { recursive: true });
    mkdirSync(join(repo.path, 'src'), { recursive: true });
    writeFileSync(join(repo.path, 'src', 'value.ts'), 'export const value = 0;\n', 'utf8');
    execFileSync('git', ['add', 'src/value.ts'], { cwd: repo.path });
    execFileSync('git', ['commit', '-m', 'add source'], { cwd: repo.path });
    writeFileSync(join(workflowDir, 'companion-e2e.yaml'), [
      'name: companion-e2e',
      'initial_step: implement',
      'max_steps: 2',
      'steps:',
      '  - name: implement',
      '    persona: coder',
      '    instruction: implement',
      '    edit: true',
      '    companion: [security-reviewer]',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
      '',
    ].join('\n'), 'utf8');
    writeFileSync(join(companionDir, 'security-reviewer.yaml'), [
      'name: security-reviewer',
      'description: Review the implementation for security defects',
      'interval_ms: 60000',
      '',
    ].join('\n'), 'utf8');
    writeFileSync(join(isolatedEnv.taktDir, 'config.yaml'), [
      'language: en',
      'notification_sound: false',
      'analytics:',
      '  enabled: true',
      `  events_path: ${JSON.stringify(analyticsEventsDir)}`,
      '',
    ].join('\n'), 'utf8');
    writeFileSync(join(repo.path, '.takt', 'runtime.yaml'), [
      'version: 1',
      'companion:',
      '  enabled: true',
      ...(fixPolicy === undefined ? [] : [`  fix_policy: ${fixPolicy}`]),
      'provider:',
      '  profiles:',
      '    mock:',
      '      provider: mock',
      '      model: mock-model',
      '  defaults:',
      '    profile: mock',
      '  targets:',
      '    companions:',
      '      security-reviewer:',
      '        profile: mock',
      '',
    ].join('\n'), 'utf8');
    execFileSync('git', ['add', '.'], { cwd: repo.path });
    execFileSync('git', ['commit', '-m', 'add companion fixture'], { cwd: repo.path });
    execFileSync('git', ['clone', '--quiet', repo.path, cloneDir]);
    const workflowPath = join(cloneDir, '.takt', 'workflows', 'companion-e2e.yaml');
    const scenarioPath = join(isolatedEnv.taktDir, 'companion-scenario.json');
    writeFileSync(scenarioPath, JSON.stringify([
      {
        persona: 'coder',
        content: 'Initial implementation complete.',
        stream_events: [{
          type: 'tool_use',
          tool: 'Edit',
          id: 'edit-1',
          input: { file_path: 'src/value.ts' },
        }],
        file_writes: [{ path: 'src/value.ts', content: 'export const value = -1;\n' }],
      },
      {
        persona: 'security-reviewer',
        content: 'Found an invalid value.',
        structured_output: {
          findings: [{
            severity: 'must_fix',
            file: 'src/value.ts',
            line: 1,
            finding: 'The exported value must not be negative.',
          }],
          notes: 'Check the value again.',
        },
      },
      {
        persona: 'coder',
        content: 'Fixed the companion finding.',
        stream_events: [{
          type: 'tool_use',
          tool: 'Edit',
          id: 'edit-2',
          input: { file_path: 'src/value.ts' },
        }],
        file_writes: [{ path: 'src/value.ts', content: 'export const value = 1;\n' }],
      },
      ...(fixPolicy === 'loop'
        ? [{
            persona: 'security-reviewer',
            content: 'No findings remain.',
            structured_output: {
              findings: [],
              notes: 'No findings.',
            },
          }]
        : []),
    ]), 'utf8');
    const callLogPath = join(isolatedEnv.taktDir, 'companion-calls.jsonl');
    const promptLogPath = join(isolatedEnv.taktDir, 'companion-prompts.jsonl');

    const result = runTakt({
      args: ['--task', 'Implement a valid exported value', '--workflow', workflowPath],
      cwd: cloneDir,
      env: {
        ...isolatedEnv.env,
        TAKT_MOCK_SCENARIO: scenarioPath,
        TAKT_MOCK_CALL_LOG: callLogPath,
        TAKT_MOCK_PROMPT_LOG: promptLogPath,
      },
      timeout: 180_000,
      injectProvider: false,
    });

    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(
      readFileSync(join(cloneDir, 'src', 'value.ts'), 'utf8'),
      `${result.stdout}\n${result.stderr}`,
    ).toBe('export const value = 1;\n');
    const runSlug = readdirSync(join(cloneDir, '.takt', 'runs'))[0];
    expect(runSlug).toBeDefined();
    const mailbox = readFileSync(join(
      cloneDir,
      '.takt',
      'runs',
      runSlug!,
      'companion',
      'implement',
      'security-reviewer.jsonl',
    ), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(mailbox).toEqual([
      expect.objectContaining({
        companion: 'security-reviewer',
        reviewedDigest: expect.any(String),
        reviewedAt: expect.any(String),
        severity: 'must_fix',
      }),
    ]);
    const calls = readFileSync(callLogPath, 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line) as {
        event: string;
        personaName: string;
        inputSessionId?: string;
        returnedSessionId?: string;
      });
    expect(calls.filter(({ event, personaName }) => (
      event === 'start' && personaName === 'security-reviewer'
    ))).toHaveLength(expectedReviewerStarts);
    expect(calls.filter(({ event, personaName }) => (
      event === 'start' && personaName === 'coder'
    ))).toHaveLength(2);
    expect(calls.map(({ event, personaName }) => `${personaName}:${event}`)).toEqual([
      'coder:start',
      'coder:complete',
      'security-reviewer:start',
      'security-reviewer:complete',
      'coder:start',
      'coder:complete',
      ...(fixPolicy === 'loop'
        ? ['security-reviewer:start', 'security-reviewer:complete']
        : []),
    ]);
    const reviewRounds = readSessionRecords(cloneDir)
      .filter((record) => record.type === 'companion_review_round')
      .map((record) => ({ step: record.step, findingCount: record.findingCount }));
    expect(reviewRounds).toEqual([
      { step: 'implement', findingCount: 1 },
      ...(fixPolicy === 'loop' ? [{ step: 'implement', findingCount: 0 }] : []),
    ]);
    expectSuccessfulParentCompanionCompletion(readJsonlDirectory(analyticsEventsDir));
    if (fixPolicy === undefined) {
      expectSingleFixPrompt(readJsonl(promptLogPath), 'coder', 2);
    }
    const coderStarts = calls.filter(({ event, personaName }) => (
      event === 'start' && personaName === 'coder'
    ));
    const firstCoderComplete = calls.find(({ event, personaName }) => (
      event === 'complete' && personaName === 'coder'
    ));
    expect(coderStarts[0]?.inputSessionId).toBeUndefined();
    expect(firstCoderComplete?.returnedSessionId).toBeDefined();
    expect(coderStarts[1]?.inputSessionId).toBe(firstCoderComplete?.returnedSessionId);
    expect(existsSync(join(repo.path, '.takt', 'runs'))).toBe(false);
    const mailboxPath = join(
      cloneDir,
      '.takt',
      'runs',
      runSlug!,
      'companion',
      'implement',
      'security-reviewer.jsonl',
    );
    expect(execFileSync('git', ['check-ignore', mailboxPath], {
      cwd: cloneDir,
      encoding: 'utf8',
    }).trim()).toBe(mailboxPath);
  });

  it.each([
    {
      name: 'should explicitly loop after a Team Leader pulls a moderated finding into a new part',
      fixPolicy: 'loop' as const,
      expectedLeaderStarts: 4,
      expectedReviewerStarts: 4,
    },
    {
      name: 'should default to one Team Leader correction batch without cumulative re-review',
      fixPolicy: undefined,
      expectedLeaderStarts: 3,
      expectedReviewerStarts: 3,
    },
  ])('$name', ({
    fixPolicy,
    expectedLeaderStarts,
    expectedReviewerStarts,
  }) => {
    const workflowDir = join(repo.path, '.takt', 'workflows');
    const companionDir = join(repo.path, '.takt', 'companions');
    const analyticsEventsDir = join(isolatedEnv.taktDir, 'team-leader-companion-analytics');
    mkdirSync(workflowDir, { recursive: true });
    mkdirSync(companionDir, { recursive: true });
    mkdirSync(join(repo.path, 'src'), { recursive: true });
    writeFileSync(join(repo.path, 'src', 'value.ts'), 'export const value = 0;\n', 'utf8');
    execFileSync('git', ['add', 'src/value.ts'], { cwd: repo.path });
    execFileSync('git', ['commit', '-m', 'add source for team leader'], { cwd: repo.path });
    writeFileSync(join(workflowDir, 'team-leader-companion-e2e.yaml'), [
      'name: team-leader-companion-e2e',
      'initial_step: implement',
      'max_steps: 3',
      'steps:',
      '  - name: implement',
      '    persona: team-leader',
      '    instruction: implement',
      '    edit: true',
      '    team_leader:',
      '      max_parts: 1',
      '      part_persona: coder',
      '      part_edit: true',
      '      part_allowed_tools: [Read, Edit]',
      '    companion:',
      '      fixed: [security-reviewer]',
      '      moderator: adjudicator',
      '    rules:',
      '      - condition: done',
      '        next: COMPLETE',
      '',
    ].join('\n'), 'utf8');
    writeFileSync(join(companionDir, 'security-reviewer.yaml'), [
      'name: security-reviewer',
      'description: Review the complete Team Leader change',
      'interval_ms: 60000',
      '',
    ].join('\n'), 'utf8');
    writeFileSync(join(companionDir, 'adjudicator.yaml'), [
      'name: adjudicator',
      'description: Moderate Team Leader review findings',
      'interval_ms: 60000',
      '',
    ].join('\n'), 'utf8');
    writeFileSync(join(isolatedEnv.taktDir, 'config.yaml'), [
      'language: en',
      'notification_sound: false',
      'analytics:',
      '  enabled: true',
      `  events_path: ${JSON.stringify(analyticsEventsDir)}`,
      '',
    ].join('\n'), 'utf8');
    writeFileSync(join(repo.path, '.takt', 'runtime.yaml'), [
      'version: 1',
      'companion:',
      '  enabled: true',
      ...(fixPolicy === undefined ? [] : [`  fix_policy: ${fixPolicy}`]),
      'provider:',
      '  profiles:',
      '    mock:',
      '      provider: mock',
      '      model: mock-model',
      '  defaults:',
      '    profile: mock',
      '  targets:',
      '    companions:',
      '      security-reviewer:',
      '        profile: mock',
      '      adjudicator:',
      '        profile: mock',
      '',
    ].join('\n'), 'utf8');
    execFileSync('git', ['add', '.'], { cwd: repo.path });
    execFileSync('git', ['commit', '-m', 'add team leader companion fixture'], { cwd: repo.path });
    execFileSync('git', ['clone', '--quiet', repo.path, cloneDir]);
    const workflowPath = join(cloneDir, '.takt', 'workflows', 'team-leader-companion-e2e.yaml');
    const scenarioPath = join(isolatedEnv.taktDir, 'team-leader-companion-scenario.json');
    writeFileSync(scenarioPath, JSON.stringify([
      {
        persona: 'team-leader',
        content: 'Initial decomposition.',
        structured_output: {
          parts: [{ id: 'initial', title: 'Implement value', instruction: 'Implement the value.' }],
        },
      },
      {
        persona: 'team-leader',
        content: 'The completion review found a correction to make.',
        structured_output: {
          done: true,
          reasoning: 'The reviewed value must be corrected.',
          cancelPartIds: [],
          parts: [],
        },
      },
      {
        persona: 'team-leader',
        content: 'The finding requires a fix part.',
        structured_output: {
          done: false,
          reasoning: 'The reviewed value must be corrected.',
          cancelPartIds: [],
          parts: [{ id: 'fix', title: 'Fix value', instruction: 'Fix the value.' }],
        },
      },
      ...(fixPolicy === 'loop'
        ? [{
            persona: 'team-leader',
            content: 'The implementation is complete.',
            structured_output: {
              done: true,
              reasoning: 'The corrected value is ready.',
              cancelPartIds: [],
              parts: [],
            },
          }]
        : []),
      {
        persona: 'coder',
        content: 'Initial implementation complete.',
        stream_events: [{
          type: 'tool_use',
          tool: 'Edit',
          id: 'team-leader-edit-1',
          input: { file_path: 'src/value.ts' },
        }],
        file_writes: [{ path: 'src/value.ts', content: 'export const value = -1;\n' }],
      },
      {
        persona: 'coder',
        content: 'Fixed the moderated finding.',
        stream_events: [{
          type: 'tool_use',
          tool: 'Edit',
          id: 'team-leader-edit-2',
          input: { file_path: 'src/value.ts' },
        }],
        file_writes: [{ path: 'src/value.ts', content: 'export const value = 1;\n' }],
      },
      {
        persona: 'security-reviewer',
        content: 'No findings remain for the initial part.',
        structured_output: {
          findings: [],
          notes: 'The initial part is ready for Team review.',
        },
      },
      {
        persona: 'security-reviewer',
        content: 'Found an invalid value.',
        structured_output: {
          findings: [{
            severity: 'must_fix',
            file: 'src/value.ts',
            line: 1,
            finding: 'The exported value must not be negative.',
          }],
          notes: 'The parent should add a fix part.',
        },
      },
      {
        persona: 'adjudicator',
        content: 'Accepted the finding.',
        structured_output: {
          findings: [{ action: 'accept', sourceIndex: 0 }],
        },
      },
      {
        persona: 'security-reviewer',
        content: 'No findings remain for the fix part.',
        structured_output: {
          findings: [],
          notes: 'The fix part is valid.',
        },
      },
      ...(fixPolicy === 'loop'
        ? [{
            persona: 'security-reviewer',
            content: 'No findings remain.',
            structured_output: {
              findings: [],
              notes: 'The cumulative change is valid.',
            },
          }]
        : []),
    ]), 'utf8');
    const callLogPath = join(isolatedEnv.taktDir, 'team-leader-companion-calls.jsonl');
    const promptLogPath = join(isolatedEnv.taktDir, 'team-leader-companion-prompts.jsonl');

    const result = runTakt({
      args: ['--task', 'Implement a valid exported value with a Team Leader', '--workflow', workflowPath],
      cwd: cloneDir,
      env: {
        ...isolatedEnv.env,
        TAKT_MOCK_SCENARIO: scenarioPath,
        TAKT_MOCK_CALL_LOG: callLogPath,
        TAKT_MOCK_PROMPT_LOG: promptLogPath,
      },
      timeout: 180_000,
      injectProvider: false,
    });

    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(readFileSync(join(cloneDir, 'src', 'value.ts'), 'utf8'), `${result.stdout}\n${result.stderr}`)
      .toBe('export const value = 1;\n');
    const runSlug = readdirSync(join(cloneDir, '.takt', 'runs'))[0];
    expect(runSlug).toBeDefined();
    const mailboxPath = join(
      cloneDir,
      '.takt',
      'runs',
      runSlug!,
      'companion',
      'implement',
      'security-reviewer.jsonl',
    );
    const mailbox = readFileSync(mailboxPath, 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(mailbox).toEqual([
      expect.objectContaining({
        companion: 'security-reviewer',
        severity: 'must_fix',
        finding: 'The exported value must not be negative.',
      }),
    ]);
    const calls = readFileSync(callLogPath, 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line) as { event: string; personaName: string });
    expect(calls.filter(({ event, personaName }) => (
      event === 'start' && personaName === 'team-leader'
    ))).toHaveLength(expectedLeaderStarts);
    expect(calls.filter(({ event, personaName }) => (
      event === 'start' && personaName === 'coder'
    ))).toHaveLength(2);
    expect(calls.filter(({ event, personaName }) => (
      event === 'start' && personaName === 'security-reviewer'
    ))).toHaveLength(expectedReviewerStarts);
    expect(calls.filter(({ event, personaName }) => (
      event === 'start' && personaName === 'adjudicator'
    ))).toHaveLength(1);
    expect(calls.map(({ event, personaName }) => `${personaName}:${event}`)).toEqual([
      'team-leader:start',
      'team-leader:complete',
      'coder:start',
      'coder:complete',
      'security-reviewer:start',
      'security-reviewer:complete',
      'team-leader:start',
      'team-leader:complete',
      'security-reviewer:start',
      'security-reviewer:complete',
      'adjudicator:start',
      'adjudicator:complete',
      'team-leader:start',
      'team-leader:complete',
      'coder:start',
      'coder:complete',
      'security-reviewer:start',
      'security-reviewer:complete',
      ...(fixPolicy === 'loop'
        ? [
            'team-leader:start',
            'team-leader:complete',
            'security-reviewer:start',
            'security-reviewer:complete',
          ]
        : []),
    ]);
    const reviewRounds = readSessionRecords(cloneDir)
      .filter((record) => record.type === 'companion_review_round')
      .map((record) => ({ step: record.step, findingCount: record.findingCount }));
    expect(reviewRounds).toEqual([
      { step: 'implement.initial', findingCount: 0 },
      { step: 'implement', findingCount: 1 },
      { step: 'implement.fix', findingCount: 0 },
      ...(fixPolicy === 'loop' ? [{ step: 'implement', findingCount: 0 }] : []),
    ]);
    expectSuccessfulParentCompanionCompletion(readJsonlDirectory(analyticsEventsDir));
    if (fixPolicy === undefined) {
      expectSingleFixPrompt(readJsonl(promptLogPath), 'team-leader', 3);
    }
  });
});
