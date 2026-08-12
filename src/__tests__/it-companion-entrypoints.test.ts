import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const PROJECT_ROOT = resolve('.');
const VITE_NODE = resolve(PROJECT_ROOT, 'node_modules/.bin/vite-node');
const PROJECT_TAKT_GITIGNORE = resolve(PROJECT_ROOT, 'builtins/project/dotgitignore');
const ENTRYPOINT_RUNNER = resolve(
  PROJECT_ROOT,
  'src/__tests__/helpers/companion-entrypoint-runner.ts',
);
const ENTRYPOINTS = ['runtime', 'preview', 'doctor'] as const;

interface FixtureOptions {
  readonly assignment: 'target' | 'defaults' | 'legacy';
  readonly provider?: 'mock' | 'cursor';
  readonly includeCompanion?: boolean;
}

interface CompanionEntrypointFixture {
  readonly root: string;
  readonly projectDir: string;
  readonly configDir: string;
  readonly workflowPath: string;
  readonly scenarioPath: string;
}

function createFixture(options: FixtureOptions): CompanionEntrypointFixture {
  const root = mkdtempSync(join(tmpdir(), 'takt-companion-entrypoints-'));
  const projectDir = join(root, 'project');
  const configDir = join(root, 'config');
  const workflowDir = join(projectDir, '.takt', 'workflows');
  const companionDir = join(projectDir, '.takt', 'companions');
  mkdirSync(workflowDir, { recursive: true });
  mkdirSync(companionDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  const workflowPath = join(workflowDir, 'companion-entrypoint.yaml');
  writeFileSync(workflowPath, [
    'name: companion-entrypoint',
    'initial_step: implement',
    'max_steps: 1',
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
  ].join('\n'));
  if (options.includeCompanion !== false) {
    writeFileSync(join(companionDir, 'security-reviewer.yaml'), [
      'name: security-reviewer',
      'description: Review security defects',
      'interval_ms: 60000',
      '',
    ].join('\n'));
  }
  const provider = options.provider ?? 'mock';
  if (options.assignment !== 'legacy') {
    const targets = options.assignment === 'target'
      ? [
          '  targets:',
          '    companions:',
          '      security-reviewer:',
          '        profile: selected',
        ]
      : [
        ];
    writeFileSync(join(projectDir, '.takt', 'runtime.yaml'), [
      'version: 1',
      'provider:',
      '  profiles:',
      '    selected:',
      `      provider: ${provider}`,
      '      model: fixture-model',
      '  defaults:',
      '    profile: selected',
      ...targets,
      '',
    ].join('\n'));
  }
  writeFileSync(join(configDir, 'config.yaml'), [
    'language: en',
    'notification_sound: false',
    ...(options.assignment === 'legacy' ? ['provider: mock'] : []),
    '',
  ].join('\n'));
  const scenarioPath = join(configDir, 'scenario.json');
  writeFileSync(scenarioPath, JSON.stringify([{
    persona: 'coder',
    content: 'No changes required.',
  }]));
  copyFileSync(PROJECT_TAKT_GITIGNORE, join(projectDir, '.takt', '.gitignore'));
  execFileSync('git', ['init', '--quiet'], { cwd: projectDir });
  execFileSync('git', ['config', 'user.name', 'TAKT Test'], { cwd: projectDir });
  execFileSync('git', ['config', 'user.email', 'takt@example.invalid'], { cwd: projectDir });
  execFileSync('git', ['add', '.'], { cwd: projectDir });
  execFileSync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: projectDir });
  return { root, projectDir, configDir, workflowPath, scenarioPath };
}

function runEntrypoint(
  fixture: CompanionEntrypointFixture,
  entrypoint: typeof ENTRYPOINTS[number],
): Promise<{ readonly status: number | null; readonly output: string }> {
  const args = entrypoint === 'runtime'
    ? [
        '--script',
        ENTRYPOINT_RUNNER,
        '--task',
        'Validate the companion entrypoint fixture',
        '--workflow',
        fixture.workflowPath,
      ]
    : ['--script', ENTRYPOINT_RUNNER];
  return new Promise((resolveResult, reject) => {
    const child = spawn(VITE_NODE, args, {
      cwd: PROJECT_ROOT,
      timeout: 45_000,
      env: {
        ...process.env,
        TAKT_CONFIG_DIR: fixture.configDir,
        TAKT_MOCK_SCENARIO: fixture.scenarioPath,
        TAKT_TEST_WORKFLOW_CWD: fixture.projectDir,
        TAKT_TEST_ENTRYPOINT: entrypoint,
        TAKT_TEST_WORKFLOW_IDENTIFIER: 'companion-entrypoint',
        TAKT_TEST_WORKFLOW_PATH: fixture.workflowPath,
        NO_UPDATE_NOTIFIER: '1',
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status) => {
      resolveResult({ status, output: `${stdout}\n${stderr}` });
    });
  });
}

describe('companion runtime, preview, and doctor entrypoint parity', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  const cases: readonly {
    readonly name: string;
    readonly options: FixtureOptions;
    readonly succeeds: boolean;
    readonly errorPattern?: RegExp;
  }[] = [
    {
      name: 'accepts an explicit companion target',
      options: { assignment: 'target' },
      succeeds: true,
    },
    {
      name: 'accepts provider defaults when the target is omitted',
      options: { assignment: 'defaults' },
      succeeds: true,
    },
    {
      name: 'rejects legacy provider configuration',
      options: { assignment: 'legacy' },
      succeeds: false,
      errorPattern: /require runtime\.yaml|migrate provider configuration/,
    },
    {
      name: 'rejects a provider without companion isolation support',
      options: { assignment: 'target', provider: 'cursor' },
      succeeds: false,
      errorPattern: /does not support companion strict isolated execution/,
    },
    {
      name: 'rejects an undefined companion',
      options: { assignment: 'target', includeCompanion: false },
      succeeds: false,
      errorPattern: /Undefined companion/,
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, async () => {
      const fixture = createFixture(testCase.options);
      roots.push(fixture.root);
      const results = await Promise.all(ENTRYPOINTS.map(async (entrypoint) => ({
        entrypoint,
        ...await runEntrypoint(fixture, entrypoint),
      })));

      for (const result of results) {
        if (testCase.succeeds) {
          expect(result.status, `${result.entrypoint}: ${result.output}`).toBe(0);
        } else {
          expect(result.status, `${result.entrypoint}: ${result.output}`).not.toBe(0);
          expect(result.output, result.entrypoint).toMatch(testCase.errorPattern!);
        }
      }
    }, 60_000);
  }
});
