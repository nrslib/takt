import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  invalidateAllResolvedConfigCache,
  invalidateGlobalConfigCache,
} from '../infra/config/index.js';
import { runWorkflowExecution } from '../features/tasks/execute/workflowExecutionApi.js';

const cliTraceOverride = vi.hoisted(() => ({
  enabled: false,
  profile: 'cli-review',
}));

vi.mock('../infra/config/resolveConfigValue.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../infra/config/resolveConfigValue.js')>();
  return {
    ...original,
    resolveProviderOptionsWithTrace: (
      projectDir: string,
      codexSkillDefaults?: { readonly repo: boolean; readonly user: boolean },
    ) => {
      const resolved = original.resolveProviderOptionsWithTrace(projectDir, codexSkillDefaults);
      if (!cliTraceOverride.enabled) {
        return resolved;
      }
      return {
        ...resolved,
        value: {
          ...resolved.value,
          codex: {
            ...(resolved.value?.codex ?? {}),
            permissionControl: 'codex' as const,
            configProfile: cliTraceOverride.profile,
          },
        },
        source: 'env' as const,
        originResolver: (path: string) => {
          if (path === 'codex.permissionControl' || path === 'codex.configProfile') {
            return 'cli' as const;
          }
          return resolved.originResolver(path);
        },
      };
    },
  };
});

interface Invocation {
  args: string[];
  marker: string;
  role: 'main' | 'reviewer' | 'moderator';
}

interface ProfileOptions {
  permission_control?: 'takt' | 'codex';
  config_profile?: string;
}

interface FixtureOptions {
  reviewerOptions?: ProfileOptions;
  moderatorOptions?: ProfileOptions;
  includeModerator?: boolean;
}

interface Fixture {
  executablePath: string;
  recordPath: string;
  projectCwd: string;
  configDir: string;
  workflowPath: string;
  sourcePath: string;
}

const roots: string[] = [];

function createCodexFixture(root: string): { executablePath: string; recordPath: string } {
  const executablePath = join(root, 'codex');
  const recordPath = join(root, 'codex-calls.txt');
  writeFileSync(executablePath, [
    '#!/bin/sh',
    'set -eu',
    'record="${TAKT_PROFILE_TEST_RECORD:?TAKT_PROFILE_TEST_RECORD is required}"',
    'schema_path=',
    'for argument in "$@"; do',
    '  if [ "${previous_argument:-}" = "--output-schema" ]; then schema_path="$argument"; fi',
    '  previous_argument="$argument"',
    'done',
    'role=main',
    'if [ -n "$schema_path" ]; then',
    '  if grep -q \'"action"\' "$schema_path"; then role=moderator; else role=reviewer; fi',
    'fi',
    '{',
    '  printf "role=%s\\n" "$role"',
    '  printf "%s\\n" begin',
    '  for argument in "$@"; do printf "arg=%s\\n" "$argument"; done',
    '  if [ -n "${TAKT_CODEX_CONFIG_PROFILE+x}" ]; then',
    '    printf "marker=%s\\n" "$TAKT_CODEX_CONFIG_PROFILE"',
    '  else',
    '    printf "%s\\n" marker=absent',
    '  fi',
    '  printf "%s\\n" end',
    '} >> "$record"',
    'if [ "$role" = reviewer ]; then',
    '  printf "%s\\n" \'{"type":"thread.started","thread_id":"thread-reviewer"}\'',
    '  printf "%s\\n" \'{"type":"item.completed","item":{"id":"message-reviewer","type":"agent_message","text":"{\\"findings\\":[{\\"severity\\":\\"nit\\",\\"file\\":\\"src/value.ts\\",\\"line\\":1,\\"finding\\":\\"verification finding\\"}],\\"notes\\":null}"}}\'',
    'elif [ "$role" = moderator ]; then',
    '  printf "%s\\n" \'{"type":"thread.started","thread_id":"thread-moderator"}\'',
    '  printf "%s\\n" \'{"type":"item.completed","item":{"id":"message-moderator","type":"agent_message","text":"{\\"findings\\":[{\\"action\\":\\"reject\\",\\"sourceIndex\\":0}]}"}}\'',
    'else',
    '  printf "%s\\n" \'{"type":"thread.started","thread_id":"thread-main"}\'',
    '  printf "%s\\n" \'{"type":"item.completed","item":{"id":"message-main","type":"agent_message","text":"done"}}\'',
    '  printf "%s\\n" "export const value = 1;" > "${TAKT_PROFILE_TEST_SOURCE:?TAKT_PROFILE_TEST_SOURCE is required}"',
    'fi',
    'printf "%s\\n" \'{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1,"reasoning_output_tokens":0}}\'',
    '',
  ].join('\n'), 'utf8');
  chmodSync(executablePath, 0o755);
  return { executablePath, recordPath };
}

function readInvocations(recordPath: string): Invocation[] {
  const invocations: Invocation[] = [];
  let current: Invocation | undefined;
  let pendingRole: Invocation['role'] = 'main';
  for (const line of readFileSync(recordPath, 'utf8').trim().split('\n')) {
    if (line.startsWith('role=')) {
      pendingRole = line.slice('role='.length) as Invocation['role'];
    } else if (line === 'begin') {
      current = { args: [], marker: '', role: pendingRole };
    } else if (current && line.startsWith('arg=')) {
      current.args.push(line.slice('arg='.length));
    } else if (current && line.startsWith('marker=')) {
      current.marker = line.slice('marker='.length);
    } else if (current && line === 'end') {
      invocations.push(current);
      current = undefined;
    }
  }
  return invocations;
}

function git(cwd: string, args: readonly string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
}

function profileYaml(name: string, options: ProfileOptions | undefined): string[] {
  const lines = [
    `    ${name}:`,
    '      provider: codex',
    '      model: fake-model',
  ];
  if (options !== undefined && Object.keys(options).length > 0) {
    lines.push('      options:');
    if (options.permission_control !== undefined) {
      lines.push(`        permission_control: ${options.permission_control}`);
    }
    if (options.config_profile !== undefined) {
      lines.push(`        config_profile: ${options.config_profile}`);
    }
  }
  return lines;
}

function createProjectFixture(options: FixtureOptions = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'takt-runtime-companion-profile-'));
  roots.push(root);
  const projectCwd = join(root, 'project');
  const configDir = join(root, 'config');
  const workflowDir = join(projectCwd, '.takt', 'workflows');
  const companionDir = join(projectCwd, '.takt', 'companions');
  const sourcePath = join(projectCwd, 'src', 'value.ts');
  const workflowPath = join(workflowDir, 'profile-companion.yaml');
  mkdirSync(workflowDir, { recursive: true });
  mkdirSync(companionDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  mkdirSync(join(projectCwd, 'src'), { recursive: true });

  git(root, ['init', '--quiet', projectCwd]);
  git(projectCwd, ['config', 'user.name', 'TAKT Test']);
  git(projectCwd, ['config', 'user.email', 'takt@example.invalid']);
  writeFileSync(sourcePath, 'export const value = 0;\n');
  git(projectCwd, ['add', 'src/value.ts']);
  git(projectCwd, ['commit', '--quiet', '-m', 'baseline']);

  const fixture = createCodexFixture(root);
  writeFileSync(join(configDir, 'config.yaml'), 'language: en\nnotification_sound: false\n');
  writeFileSync(join(projectCwd, '.takt', 'runtime.yaml'), [
    'version: 1',
    'companion:',
    '  enabled: true',
    '  review_mode: completion',
    'provider:',
    '  defaults:',
    '    profile: default',
    '  profiles:',
    ...profileYaml('default', { permission_control: 'takt' }),
    ...profileYaml('reviewer', options.reviewerOptions),
    ...profileYaml('moderator', options.moderatorOptions),
    '  targets:',
    '    companions:',
    '      reviewer:',
    '        profile: reviewer',
    ...(options.includeModerator === false
      ? []
      : ['      moderator:', '        profile: moderator']),
    '',
  ].join('\n'));
  writeFileSync(workflowPath, [
    'name: profile-companion',
    'initial_step: implement',
    'max_steps: 1',
    'steps:',
    '  - name: implement',
    '    persona: coder',
    '    instruction: implement the requested change',
    '    edit: true',
    ...(options.includeModerator === false
      ? ['    companion: [reviewer]']
      : ['    companion:', '      fixed: [reviewer]', '      moderator: moderator']),
    '    rules:',
    '      - condition: done',
    '        next: COMPLETE',
    '',
  ].join('\n'));
  writeFileSync(join(companionDir, 'reviewer.yaml'), [
    'name: reviewer',
    'description: Review the implementation',
    'interval_ms: 60000',
    '',
  ].join('\n'));
  if (options.includeModerator !== false) {
    writeFileSync(join(companionDir, 'moderator.yaml'), [
      'name: moderator',
      'description: Moderate the review',
      'interval_ms: 60000',
      '',
    ].join('\n'));
  }

  return {
    ...fixture,
    projectCwd,
    configDir,
    workflowPath,
    sourcePath,
  };
}

function configureFixture(
  fixture: Fixture,
  options: { permission?: 'takt' | 'codex'; profile?: string } = {},
): void {
  vi.stubEnv('TAKT_CONFIG_DIR', fixture.configDir);
  vi.stubEnv('TAKT_CODEX_CLI_PATH', fixture.executablePath);
  vi.stubEnv('OPENAI_API_KEY', 'test-api-key');
  vi.stubEnv('TAKT_PROFILE_TEST_RECORD', fixture.recordPath);
  vi.stubEnv('TAKT_PROFILE_TEST_SOURCE', fixture.sourcePath);
  if (options.permission === undefined) {
    delete process.env.TAKT_PROVIDER_OPTIONS_CODEX_PERMISSION_CONTROL;
  } else {
    vi.stubEnv('TAKT_PROVIDER_OPTIONS_CODEX_PERMISSION_CONTROL', options.permission);
  }
  if (options.profile === undefined) {
    delete process.env.TAKT_PROVIDER_OPTIONS_CODEX_CONFIG_PROFILE;
  } else {
    vi.stubEnv('TAKT_PROVIDER_OPTIONS_CODEX_CONFIG_PROFILE', options.profile);
  }
  invalidateGlobalConfigCache();
  invalidateAllResolvedConfigCache();
}

async function runFixture(fixture: Fixture) {
  return runWorkflowExecution({
    task: 'Implement the value change',
    cwd: fixture.projectCwd,
    projectCwd: fixture.projectCwd,
    workflowIdentifier: fixture.workflowPath,
    outputMode: 'silent',
  });
}

function invocationsByRole(recordPath: string): Map<Invocation['role'], Invocation> {
  return new Map(readInvocations(recordPath).map((invocation) => [invocation.role, invocation]));
}

describe('runtime provider companion resolution', () => {
  afterEach(() => {
    cliTraceOverride.enabled = false;
    vi.unstubAllEnvs();
    invalidateGlobalConfigCache();
    invalidateAllResolvedConfigCache();
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('passes runtime and environment-overridden Codex profile options to reviewer and moderator calls', async () => {
    const fixture = createProjectFixture({
      reviewerOptions: { permission_control: 'takt', config_profile: 'runtime-review' },
      moderatorOptions: { permission_control: 'takt', config_profile: 'runtime-moderate' },
    });
    configureFixture(fixture, { permission: 'codex', profile: 'automation-review' });

    const result = await runFixture(fixture);

    expect(result.success).toBe(true);
    expect(readFileSync(fixture.sourcePath, 'utf8')).toBe('export const value = 1;\n');
    const invocations = readInvocations(fixture.recordPath);
    expect(invocations.map(({ role }) => role)).toEqual(['main', 'reviewer', 'moderator']);
    for (const invocation of invocations) {
      const profileIndex = invocation.args.indexOf('--profile');
      expect(invocation.args.slice(profileIndex, profileIndex + 2))
        .toEqual(['--profile', 'automation-review']);
      expect(invocation.marker).toBe('absent');
    }
  });

  it('preserves each companion runtime profile when the environment profile is unspecified', async () => {
    const fixture = createProjectFixture({
      reviewerOptions: { permission_control: 'codex', config_profile: 'runtime-review' },
      moderatorOptions: { permission_control: 'codex', config_profile: 'runtime-moderate' },
    });
    configureFixture(fixture, { permission: 'codex' });

    await expect(runFixture(fixture)).resolves.toMatchObject({ success: true });

    const invocations = invocationsByRole(fixture.recordPath);
    expect(invocations.get('reviewer')?.args.slice(
      invocations.get('reviewer')?.args.indexOf('--profile'),
      (invocations.get('reviewer')?.args.indexOf('--profile') ?? -1) + 2,
    )).toEqual(['--profile', 'runtime-review']);
    expect(invocations.get('moderator')?.args.slice(
      invocations.get('moderator')?.args.indexOf('--profile'),
      (invocations.get('moderator')?.args.indexOf('--profile') ?? -1) + 2,
    )).toEqual(['--profile', 'runtime-moderate']);
    expect(invocations.get('reviewer')?.marker).toBe('absent');
    expect(invocations.get('moderator')?.marker).toBe('absent');
  });

  it('resolves environment-only options when companion profile options are unspecified', async () => {
    const fixture = createProjectFixture();
    configureFixture(fixture, { permission: 'codex', profile: 'automation-review' });

    await expect(runFixture(fixture)).resolves.toMatchObject({ success: true });

    const invocations = invocationsByRole(fixture.recordPath);
    for (const role of ['reviewer', 'moderator'] as const) {
      const invocation = invocations.get(role);
      expect(invocation).toBeDefined();
      const profileIndex = invocation?.args.indexOf('--profile') ?? -1;
      expect(invocation?.args.slice(profileIndex, profileIndex + 2))
        .toEqual(['--profile', 'automation-review']);
    }
  });

  it('does not add a profile to reviewer or moderator calls when the profile is unspecified', async () => {
    const fixture = createProjectFixture({
      reviewerOptions: { permission_control: 'codex' },
      moderatorOptions: { permission_control: 'codex' },
    });
    configureFixture(fixture, { permission: 'codex' });

    await expect(runFixture(fixture)).resolves.toMatchObject({ success: true });

    const invocations = invocationsByRole(fixture.recordPath);
    for (const role of ['reviewer', 'moderator'] as const) {
      expect(invocations.get(role)?.args).not.toContain('--profile');
      expect(invocations.get(role)?.marker).toBe('absent');
    }
  });

  it('propagates a CLI-origin profile change through reviewer and moderator execution', async () => {
    const reviewFixture = createProjectFixture({
      reviewerOptions: { permission_control: 'codex', config_profile: 'runtime-review' },
      moderatorOptions: { permission_control: 'codex', config_profile: 'runtime-moderate' },
    });
    configureFixture(reviewFixture);
    cliTraceOverride.enabled = true;
    cliTraceOverride.profile = 'cli-review';

    await expect(runFixture(reviewFixture)).resolves.toMatchObject({ success: true });

    const implementFixture = createProjectFixture({
      reviewerOptions: { permission_control: 'codex', config_profile: 'runtime-review' },
      moderatorOptions: { permission_control: 'codex', config_profile: 'runtime-moderate' },
    });
    configureFixture(implementFixture);
    cliTraceOverride.profile = 'cli-implement';

    await expect(runFixture(implementFixture)).resolves.toMatchObject({ success: true });

    for (const [recordPath, expectedProfile] of [
      [reviewFixture.recordPath, 'cli-review'],
      [implementFixture.recordPath, 'cli-implement'],
    ] as const) {
      const invocations = invocationsByRole(recordPath);
      for (const role of ['reviewer', 'moderator'] as const) {
        const invocation = invocations.get(role);
        expect(invocation).toBeDefined();
        const profileIndex = invocation?.args.indexOf('--profile') ?? -1;
        expect(invocation?.args.slice(profileIndex, profileIndex + 2))
          .toEqual(['--profile', expectedProfile]);
        expect(invocation?.marker).toBe('absent');
      }
    }
  });

  it('rejects an invalid permission/profile combination before any Codex process starts', async () => {
    const fixture = createProjectFixture({
      reviewerOptions: { permission_control: 'takt', config_profile: 'runtime-review' },
      moderatorOptions: { permission_control: 'takt', config_profile: 'runtime-moderate' },
    });
    configureFixture(fixture, { permission: 'takt', profile: 'automation-review' });

    await expect(runFixture(fixture)).rejects.toThrow(/config_profile.*permission_control/);
    expect(existsSync(fixture.recordPath)).toBe(false);
  });

  it.each([
    { role: 'reviewer' as const, includeModerator: false },
    { role: 'moderator' as const, includeModerator: true },
  ])('rejects an invalid permission/profile combination for the $role companion before spawn', async ({
    role,
    includeModerator,
  }) => {
    const fixture = createProjectFixture({
      reviewerOptions: role === 'reviewer'
        ? { config_profile: 'automation-review' }
        : { permission_control: 'codex' },
      moderatorOptions: role === 'moderator'
        ? { config_profile: 'automation-review' }
        : undefined,
      includeModerator,
    });
    configureFixture(fixture);

    await expect(runFixture(fixture)).rejects.toThrow(/config_profile.*permission_control/);
    expect(existsSync(fixture.recordPath)).toBe(false);
  });
});
