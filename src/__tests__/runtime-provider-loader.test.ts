import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const mockedHome = vi.hoisted(() => ({ value: '' }));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => mockedHome.value || actual.homedir() };
});

// New module under test (implemented in the following `implement` step).
import {
  loadRuntimeProviderFileAt,
  resolveRuntimeProviderFile,
  resolveRuntimeProviderFileWithOrigins,
} from '../infra/config/runtime-provider/loader.js';
import { RUNTIME_PROVIDER_FILENAME } from '../infra/config/runtime-provider/constants.js';

/**
 * Contracts covered (see plan.md 完了契約):
 * - C1 fixed two paths (~/.takt/runtime.yaml, <project>/.takt/runtime.yaml), schema-validated
 * - C3 project settings take priority over global
 * - C2 same-name profile is replaced wholesale (no field-level merge)
 *
 * The loader takes explicit directories (no implicit homedir/cwd fallback), matching
 * the "解決責務の一元化 / pass paths from above" policy.
 */

let root: string;
let globalDir: string;
let projectDir: string;

function writeRuntimeYaml(dir: string, lines: string[]): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, RUNTIME_PROVIDER_FILENAME), lines.join('\n'), 'utf-8');
}

function companionReviewMode(value: unknown): string | undefined {
  return (value as { review_mode?: string } | undefined)?.review_mode;
}

function companionFixPolicy(value: unknown): string | undefined {
  return (value as { fix_policy?: string } | undefined)?.fix_policy;
}

describe('runtime-provider loader', () => {
  beforeEach(() => {
    // Unique per-run directory: a fixed tmpdir path would let two concurrent runs of this
    // file delete each other's fixtures.
    root = mkdtempSync(join(tmpdir(), 'takt-runtime-provider-loader-'));
    globalDir = join(root, 'global-.takt');
    projectDir = join(root, 'project-.takt');
    mockedHome.value = dirname(projectDir);
  });

  afterEach(() => {
    mockedHome.value = '';
    rmSync(root, { recursive: true, force: true });
  });

  it('Given a missing file, When loading a single path, Then it returns undefined (C1)', () => {
    mkdirSync(globalDir, { recursive: true });
    expect(loadRuntimeProviderFileAt(join(globalDir, RUNTIME_PROVIDER_FILENAME))).toBeUndefined();
  });

  it('Given an invalid runtime.yaml, When loading, Then it throws naming the failing file path (schema validation, C1)', () => {
    writeRuntimeYaml(globalDir, ['version: 2']);
    const filePath = join(globalDir, RUNTIME_PROVIDER_FILENAME);
    expect(() => loadRuntimeProviderFileAt(filePath)).toThrow(filePath);
  });

  it('Given an unselected target referencing an unknown server, When loading, Then it fails before target matching', () => {
    writeRuntimeYaml(globalDir, [
      'version: 1',
      'mcp:',
      '  servers:',
      '    known:',
      '      command: known-server',
      '  targets:',
      '    personas:',
      '      never-matched:',
      '        servers:',
      '          - missing-server',
    ]);

    expect(() => loadRuntimeProviderFileAt(join(globalDir, RUNTIME_PROVIDER_FILENAME))).toThrow(
      'MCP target personas.never-matched.servers references unknown server "missing-server"',
    );
  });

  it('Given an unused server with an undefined environment reference, When loading, Then it does not interpolate that server', () => {
    writeRuntimeYaml(globalDir, [
      'version: 1',
      'mcp:',
      '  servers:',
      '    unused:',
      '      command: ${TAKT_PHASE2_UNUSED_ENV}',
      '    selected:',
      '      command: selected-server',
      '  defaults:',
      '    servers:',
      '      - selected',
    ]);

    expect(loadRuntimeProviderFileAt(join(globalDir, RUNTIME_PROVIDER_FILENAME))).toBeDefined();
  });

  it.each([
    ['without auto_routing', [
      'version: 1',
      'provider:',
      '  profiles:',
      '    default:',
      '      provider: mock',
      '      model: runtime-model',
    ]],
    ['with auto_routing', [
      'version: 1',
      'provider:',
      '  profiles:',
      '    default:',
      '      provider: mock',
      '      model: runtime-model',
      '    router:',
      '      provider: mock',
      '      model: router-model',
      '  auto_routing:',
      '    router_profile: router',
      '    pools:',
      '      main:',
      '        candidates:',
      '          - profile: default',
      '            tier: low',
      '        fallback_profile: default',
    ]],
  ])('Given an active provider file %s without defaults, When loading, Then it fails with the defaults cause', (_label, lines) => {
    writeRuntimeYaml(globalDir, lines);
    const filePath = join(globalDir, RUNTIME_PROVIDER_FILENAME);

    expect(() => loadRuntimeProviderFileAt(filePath)).toThrow(/defaults/);
  });

  it('Given an empty runtime.yaml, When loading, Then it is treated as unset (C1)', () => {
    writeRuntimeYaml(globalDir, ['']);
    expect(loadRuntimeProviderFileAt(join(globalDir, RUNTIME_PROVIDER_FILENAME))).toBeUndefined();
  });

  it('Given only the global file, When resolving, Then the global config is returned (C1)', () => {
    writeRuntimeYaml(globalDir, [
      'version: 1',
      'provider:',
      '  defaults:',
      '    profile: g',
      '  profiles:',
      '    g:',
      '      provider: mock',
      '      model: global-model',
    ]);
    const resolved = resolveRuntimeProviderFile({ globalConfigDir: globalDir, projectConfigDir: projectDir });
    expect(resolved?.provider?.profiles?.g?.model).toBe('global-model');
  });

  it('Given only the project file, When resolving, Then the project config is returned (C1)', () => {
    writeRuntimeYaml(projectDir, [
      'version: 1',
      'provider:',
      '  defaults:',
      '    profile: p',
      '  profiles:',
      '    p:',
      '      provider: mock',
      '      model: project-model',
    ]);
    const resolved = resolveRuntimeProviderFile({ globalConfigDir: globalDir, projectConfigDir: projectDir });
    expect(resolved?.provider?.profiles?.p?.model).toBe('project-model');
  });

  it('Given both files, When resolving, Then project takes priority over global (C3)', () => {
    writeRuntimeYaml(globalDir, [
      'version: 1',
      'provider:',
      '  defaults:',
      '    profile: base',
      '  profiles:',
      '    base:',
      '      provider: mock',
      '      model: global-model',
    ]);
    writeRuntimeYaml(projectDir, [
      'version: 1',
      'provider:',
      '  defaults:',
      '    profile: base',
      '  profiles:',
      '    base:',
      '      provider: codex',
      '      model: project-model',
    ]);
    const resolved = resolveRuntimeProviderFile({ globalConfigDir: globalDir, projectConfigDir: projectDir });
    expect(resolved?.provider?.profiles?.base?.model).toBe('project-model');
    expect(resolved?.provider?.profiles?.base?.provider).toBe('codex');
  });

  it('Given overlapping and disjoint profiles, When resolving, Then same-name profile is replaced wholesale and others are retained (C2)', () => {
    // global `shared` carries an `options` field that project's `shared` omits.
    writeRuntimeYaml(globalDir, [
      'version: 1',
      'provider:',
      '  defaults:',
      '    profile: shared',
      '  profiles:',
      '    shared:',
      '      provider: codex',
      '      model: global-model',
      '      options:',
      '        reasoning_effort: high',
      '    global-only:',
      '      provider: mock',
      '      model: keep-me',
    ]);
    writeRuntimeYaml(projectDir, [
      'version: 1',
      'provider:',
      '  defaults:',
      '    profile: shared',
      '  profiles:',
      '    shared:',
      '      provider: codex',
      '      model: project-model',
      '    project-only:',
      '      provider: mock',
      '      model: added',
    ]);
    const resolved = resolveRuntimeProviderFile({ globalConfigDir: globalDir, projectConfigDir: projectDir });

    // same-name profile fully replaced: project fields win AND the global-only `options` is gone.
    expect(resolved?.provider?.profiles?.shared?.model).toBe('project-model');
    expect(resolved?.provider?.profiles?.shared?.options).toBeUndefined();
    // disjoint profiles from both layers are retained.
    expect(resolved?.provider?.profiles?.['global-only']?.model).toBe('keep-me');
    expect(resolved?.provider?.profiles?.['project-only']?.model).toBe('added');
  });

  it('tracks the origin layer of every profile after project replacement', () => {
    writeRuntimeYaml(globalDir, [
      'version: 1',
      'provider:',
      '  defaults:',
      '    profile: shared',
      '  profiles:',
      '    shared:',
      '      provider: mock',
      '      model: global',
      '    global-only:',
      '      provider: mock',
      '      model: global-only',
    ]);
    writeRuntimeYaml(projectDir, [
      'version: 1',
      'provider:',
      '  defaults:',
      '    profile: shared',
      '  profiles:',
      '    shared:',
      '      provider: mock',
      '      model: project',
      '    project-only:',
      '      provider: mock',
      '      model: project-only',
    ]);

    const resolved = resolveRuntimeProviderFileWithOrigins({
      globalConfigDir: globalDir,
      projectConfigDir: projectDir,
    });

    expect(resolved.profileOrigins).toEqual(new Map([
      ['shared', 'project'],
      ['global-only', 'global'],
      ['project-only', 'project'],
    ]));
  });

  it('Given both files carry `targets`, When resolving, Then the whole targets section is replaced by project (no deep merge, C2)', () => {
    writeRuntimeYaml(globalDir, [
      'version: 1',
      'provider:',
      '  defaults:',
      '    profile: p',
      '  profiles:',
      '    p:',
      '      provider: mock',
      '      model: m',
      '  targets:',
      '    personas:',
      '      coder:',
      '        profile: p',
    ]);
    writeRuntimeYaml(projectDir, [
      'version: 1',
      'provider:',
      '  defaults:',
      '    profile: p',
      '  profiles:',
      '    p:',
      '      provider: mock',
      '      model: m',
      '  targets:',
      '    tags:',
      '      high-stakes:',
      '        profile: p',
    ]);
    const resolved = resolveRuntimeProviderFile({ globalConfigDir: globalDir, projectConfigDir: projectDir });
    // section-level replacement: project targets wins wholesale, global `personas` disappears.
    expect(resolved?.provider?.targets?.tags?.['high-stakes']?.profile).toBe('p');
    expect(resolved?.provider?.targets?.personas).toBeUndefined();
  });

  it('applies the matching assignment, falls back to top-level defaults, and replaces targets as a whole', () => {
    const projectRoot = dirname(projectDir);
    writeRuntimeYaml(globalDir, [
      'version: 1',
      'provider:',
      '  defaults:',
      '    profile: base',
      '  profiles:',
      '    base:',
      '      provider: mock',
      '      model: base-model',
      '    selected:',
      '      provider: codex',
      '      model: selected-model',
      '  targets:',
      '    personas:',
      '      coder:',
      '        profile: base',
      '  assignments:',
      '    project:',
      '      targets:',
      '        tags:',
      '          high-stakes:',
      '            profile: selected',
      '  directories:',
      `    ${projectRoot}: project`,
    ]);

    const resolved = resolveRuntimeProviderFile({ globalConfigDir: globalDir, projectConfigDir: projectDir });

    expect(resolved?.provider?.defaults).toEqual({ profile: 'base' });
    expect(resolved?.provider?.targets).toEqual({
      tags: { 'high-stakes': { profile: 'selected' } },
    });
    expect(resolved?.provider?.targets?.personas).toBeUndefined();
  });

  it('falls back to top-level targets when a matching assignment omits targets', () => {
    const projectRoot = dirname(projectDir);
    writeRuntimeYaml(globalDir, [
      'version: 1',
      'provider:',
      '  defaults:',
      '    profile: base',
      '  profiles:',
      '    base:',
      '      provider: mock',
      '      model: base-model',
      '    selected:',
      '      provider: codex',
      '      model: selected-model',
      '  targets:',
      '    personas:',
      '      coder:',
      '        profile: base',
      '  assignments:',
      '    project:',
      '      defaults:',
      '        profile: selected',
      '  directories:',
      `    ${projectRoot}: project`,
    ]);

    const resolved = resolveRuntimeProviderFile({ globalConfigDir: globalDir, projectConfigDir: projectDir });

    expect(resolved?.provider?.defaults).toEqual({ profile: 'selected' });
    expect(resolved?.provider?.targets).toEqual({
      personas: { coder: { profile: 'base' } },
    });
  });

  it('leaves the top-level assignment unchanged when no directory matches', () => {
    const projectRoot = dirname(projectDir);
    writeRuntimeYaml(globalDir, [
      'version: 1',
      'provider:',
      '  defaults:',
      '    profile: base',
      '  profiles:',
      '    base:',
      '      provider: mock',
      '      model: base-model',
      '    selected:',
      '      provider: codex',
      '      model: selected-model',
      '  targets:',
      '    personas:',
      '      coder:',
      '        profile: base',
      '  assignments:',
      '    other:',
      '      targets:',
      '        tags:',
      '          high-stakes:',
      '            profile: selected',
      '  directories:',
      `    ${join(projectRoot, 'other-project')}: other`,
    ]);

    const resolved = resolveRuntimeProviderFile({ globalConfigDir: globalDir, projectConfigDir: projectDir });

    expect(resolved?.provider?.defaults).toEqual({ profile: 'base' });
    expect(resolved?.provider?.targets).toEqual({
      personas: { coder: { profile: 'base' } },
    });
  });

  it('merges assignments by name and directories by normalized key with project priority', () => {
    const projectRoot = dirname(projectDir);
    const globalOnlyRoot = join(root, 'global-project');
    const projectOnlyRoot = join(root, 'project-only');
    mkdirSync(globalOnlyRoot);
    mkdirSync(projectOnlyRoot);
    writeRuntimeYaml(globalDir, [
      'version: 1',
      'provider:',
      '  defaults:',
      '    profile: base',
      '  profiles:',
      '    base:',
      '      provider: mock',
      '      model: base-model',
      '    global:',
      '      provider: mock',
      '      model: global-model',
      '    project:',
      '      provider: mock',
      '      model: global-project-model',
      '  assignments:',
      '    shared:',
      '      defaults:',
      '        profile: global',
      '    global-only:',
      '      defaults:',
      '        profile: global',
      '  directories:',
      `    ${join(projectRoot, '.')}: shared`,
      `    ${globalOnlyRoot}: global-only`,
    ]);
    writeRuntimeYaml(projectDir, [
      'version: 1',
      'provider:',
      '  defaults:',
      '    profile: base',
      '  profiles:',
      '    project:',
      '      provider: codex',
      '      model: project-model',
      '  assignments:',
      '    shared:',
      '      defaults:',
      '        profile: project',
      '    project-only:',
      '      defaults:',
      '        profile: project',
      '  directories:',
      `    ${projectRoot}: project-only`,
      `    ${projectOnlyRoot}: project-only`,
    ]);

    const resolved = resolveRuntimeProviderFile({ globalConfigDir: globalDir, projectConfigDir: projectDir });

    expect(resolved?.provider?.assignments).toEqual({
      shared: { defaults: { profile: 'project' } },
      'global-only': { defaults: { profile: 'global' } },
      'project-only': { defaults: { profile: 'project' } },
    });
    expect(resolved?.provider?.directories?.[projectRoot]).toBe('project-only');
    expect(resolved?.provider?.directories?.[globalOnlyRoot]).toBe('global-only');
    expect(resolved?.provider?.directories?.[projectOnlyRoot]).toBe('project-only');
    expect(resolved?.provider?.defaults).toEqual({ profile: 'project' });
  });

  it('fails fast when a directory points to an unknown assignment', () => {
    writeRuntimeYaml(globalDir, [
      'version: 1',
      'provider:',
      '  defaults:',
      '    profile: base',
      '  profiles:',
      '    base:',
      '      provider: mock',
      '      model: base-model',
      '  directories:',
      `    ${dirname(projectDir)}: missing`,
    ]);

    expect(() => resolveRuntimeProviderFile({ globalConfigDir: globalDir, projectConfigDir: projectDir }))
      .toThrow(/unknown assignment/i);
  });

  it('expands `~` and compares real paths for the project directory', () => {
    const realProjectRoot = join(root, 'real-project');
    const linkedProjectRoot = join(root, 'linked-project');
    mkdirSync(realProjectRoot);
    symlinkSync(realProjectRoot, linkedProjectRoot, 'dir');
    const linkedProjectConfigDir = join(linkedProjectRoot, '.takt');
    mockedHome.value = realProjectRoot;
    writeRuntimeYaml(globalDir, [
      'version: 1',
      'provider:',
      '  defaults:',
      '    profile: base',
      '  profiles:',
      '    base:',
      '      provider: mock',
      '      model: base-model',
      '    selected:',
      '      provider: codex',
      '      model: selected-model',
      '  assignments:',
      '    selected:',
      '      defaults:',
      '        profile: selected',
      '  directories:',
      '    ~/.: selected',
    ]);

    const resolved = resolveRuntimeProviderFile({
      globalConfigDir: globalDir,
      projectConfigDir: linkedProjectConfigDir,
    });

    expect(resolved?.provider?.defaults).toEqual({ profile: 'selected' });
  });

  it('Given project has an active provider section without defaults, When resolving with a valid global file, Then the project file is rejected', () => {
    writeRuntimeYaml(globalDir, [
      'version: 1',
      'provider:',
      '  defaults:',
      '    profile: g-default',
      '  profiles:',
      '    g-default:',
      '      provider: mock',
      '      model: m',
    ]);
    writeRuntimeYaml(projectDir, [
      'version: 1',
      'provider:',
      '  profiles:',
      '    p:',
      '      provider: codex',
      '      model: project-model',
    ]);
    expect(() => resolveRuntimeProviderFile({ globalConfigDir: globalDir, projectConfigDir: projectDir }))
      .toThrow(/defaults/);
  });

  it('Given both files carry `auto_routing`, When resolving, Then project auto_routing replaces global (C3)', () => {
    writeRuntimeYaml(globalDir, [
      'version: 1',
      'provider:',
      '  defaults:',
      '    profile: default',
      '  auto_routing:',
      '    strategy: balanced',
    ]);
    writeRuntimeYaml(projectDir, [
      'version: 1',
      'provider:',
      '  defaults:',
      '    profile: default',
      '  auto_routing:',
      '    strategy: performance',
    ]);
    const resolved = resolveRuntimeProviderFile({ globalConfigDir: globalDir, projectConfigDir: projectDir });
    expect(resolved?.provider?.auto_routing?.strategy).toBe('performance');
  });

  it('Given global companion.enabled=false and project companion.enabled=true, When resolving, Then companion remains disabled', () => {
    writeRuntimeYaml(globalDir, [
      'version: 1',
      'companion:',
      '  enabled: false',
    ]);
    writeRuntimeYaml(projectDir, [
      'version: 1',
      'companion:',
      '  enabled: true',
    ]);

    const resolved = resolveRuntimeProviderFile({ globalConfigDir: globalDir, projectConfigDir: projectDir });

    expect(resolved?.companion?.enabled).toBe(false);
  });

  it('Given global companion.enabled=true and an unrelated project file, When resolving, Then companion remains enabled', () => {
    writeRuntimeYaml(globalDir, [
      'version: 1',
      'companion:',
      '  enabled: true',
    ]);
    writeRuntimeYaml(projectDir, ['version: 1']);

    const resolved = resolveRuntimeProviderFile({ globalConfigDir: globalDir, projectConfigDir: projectDir });

    expect(resolved?.companion?.enabled).toBe(true);
  });

  it('Given global live and project completion policies, When resolving, Then project mode wins and enabled remains an AND', () => {
    writeRuntimeYaml(globalDir, [
      'version: 1',
      'companion:',
      '  enabled: false',
      '  review_mode: live',
    ]);
    writeRuntimeYaml(projectDir, [
      'version: 1',
      'companion:',
      '  enabled: true',
      '  review_mode: completion',
    ]);

    const resolved = resolveRuntimeProviderFile({ globalConfigDir: globalDir, projectConfigDir: projectDir });

    expect(resolved?.companion?.enabled).toBe(false);
    expect(companionReviewMode(resolved?.companion)).toBe('completion');
  });

  it('Given a global mode and a project policy without review_mode, When resolving, Then the global mode is inherited', () => {
    writeRuntimeYaml(globalDir, [
      'version: 1',
      'companion:',
      '  enabled: true',
      '  review_mode: live',
    ]);
    writeRuntimeYaml(projectDir, [
      'version: 1',
      'companion:',
      '  enabled: true',
    ]);

    const resolved = resolveRuntimeProviderFile({ globalConfigDir: globalDir, projectConfigDir: projectDir });

    expect(companionReviewMode(resolved?.companion)).toBe('live');
  });

  it('Given global loop and project single policies, When resolving, Then project policy wins without changing existing fields', () => {
    writeRuntimeYaml(globalDir, [
      'version: 1',
      'companion:',
      '  enabled: false',
      '  review_mode: live',
      '  fix_policy: loop',
    ]);
    writeRuntimeYaml(projectDir, [
      'version: 1',
      'companion:',
      '  enabled: true',
      '  review_mode: completion',
      '  fix_policy: single',
    ]);

    const resolved = resolveRuntimeProviderFile({ globalConfigDir: globalDir, projectConfigDir: projectDir });

    expect(resolved?.companion?.enabled).toBe(false);
    expect(companionReviewMode(resolved?.companion)).toBe('completion');
    expect(companionFixPolicy(resolved?.companion)).toBe('single');
  });

  it('Given a global loop policy and a project policy without fix_policy, When resolving, Then the global policy is inherited', () => {
    writeRuntimeYaml(globalDir, [
      'version: 1',
      'companion:',
      '  enabled: true',
      '  fix_policy: loop',
    ]);
    writeRuntimeYaml(projectDir, [
      'version: 1',
      'companion:',
      '  enabled: true',
    ]);

    const resolved = resolveRuntimeProviderFile({ globalConfigDir: globalDir, projectConfigDir: projectDir });

    expect(companionFixPolicy(resolved?.companion)).toBe('loop');
  });

  it('Given mode-only companion policies in both layers, When resolving, Then mode is inherited without synthesizing enabled', () => {
    writeRuntimeYaml(globalDir, [
      'version: 1',
      'companion:',
      '  review_mode: live',
    ]);
    writeRuntimeYaml(projectDir, [
      'version: 1',
      'companion:',
      '  review_mode: completion',
    ]);

    const resolved = resolveRuntimeProviderFile({ globalConfigDir: globalDir, projectConfigDir: projectDir });

    expect(resolved?.companion?.enabled).toBeUndefined();
    expect(companionReviewMode(resolved?.companion)).toBe('completion');
  });

  it('Given an invalid companion.review_mode, When loading, Then the file and field are named in the error', () => {
    writeRuntimeYaml(globalDir, [
      'version: 1',
      'companion:',
      '  enabled: false',
      '  review_mode: automatic',
    ]);
    const filePath = join(globalDir, RUNTIME_PROVIDER_FILENAME);

    expect(() => loadRuntimeProviderFileAt(filePath)).toThrow(new RegExp(`${filePath}.*review_mode`, 's'));
  });

  it('Given an invalid companion.fix_policy, When loading, Then the file and field are named in the error', () => {
    writeRuntimeYaml(globalDir, [
      'version: 1',
      'companion:',
      '  enabled: false',
      '  fix_policy: automatic',
    ]);
    const filePath = join(globalDir, RUNTIME_PROVIDER_FILENAME);

    expect(() => loadRuntimeProviderFileAt(filePath)).toThrow(new RegExp(`${filePath}.*fix_policy`, 's'));
  });

  it('Given both files omit companion, When resolving, Then companion remains undefined', () => {
    writeRuntimeYaml(globalDir, ['version: 1']);
    writeRuntimeYaml(projectDir, ['version: 1']);

    const resolved = resolveRuntimeProviderFile({ globalConfigDir: globalDir, projectConfigDir: projectDir });

    expect(resolved).toBeDefined();
    expect(resolved!.companion).toBeUndefined();
  });

  it.each(['file', 'pr-comment'] as const)(
    'Given loop analysis output is %s, When loading, Then the validated setting is returned',
    (output) => {
      writeRuntimeYaml(globalDir, [
        'version: 1',
        'loop_analysis:',
        '  enabled: true',
        `  output: ${output}`,
      ]);

      const loaded = loadRuntimeProviderFileAt(join(globalDir, RUNTIME_PROVIDER_FILENAME));

      expect(loaded?.loop_analysis).toEqual({ enabled: true, output });
    },
  );

  it('Given loop analysis output is omitted, When loading, Then file output is applied at the loader boundary', () => {
    writeRuntimeYaml(globalDir, [
      'version: 1',
      'loop_analysis:',
      '  enabled: true',
    ]);

    const loaded = loadRuntimeProviderFileAt(join(globalDir, RUNTIME_PROVIDER_FILENAME));

    expect(loaded?.loop_analysis).toEqual({ enabled: true, output: 'file' });
  });

  it('Given loop analysis is not configured, When loading, Then it remains unset', () => {
    writeRuntimeYaml(globalDir, ['version: 1']);

    const loaded = loadRuntimeProviderFileAt(join(globalDir, RUNTIME_PROVIDER_FILENAME));

    expect(loaded?.loop_analysis).toBeUndefined();
  });

  it('Given an unknown loop analysis output, When loading, Then validation rejects the file', () => {
    writeRuntimeYaml(globalDir, [
      'version: 1',
      'loop_analysis:',
      '  enabled: true',
      '  output: issue-comment',
    ]);

    expect(() => loadRuntimeProviderFileAt(join(globalDir, RUNTIME_PROVIDER_FILENAME)))
      .toThrow(/loop_analysis/);
  });

  it.each([
    ['enabled is omitted', ['version: 1', 'loop_analysis:', '  output: file']],
    ['enabled is not boolean', ['version: 1', 'loop_analysis:', '  enabled: yes-please']],
  ])('Given %s, When loading, Then validation rejects the file', (_label, lines) => {
    writeRuntimeYaml(globalDir, lines);

    expect(() => loadRuntimeProviderFileAt(join(globalDir, RUNTIME_PROVIDER_FILENAME)))
      .toThrow(/loop_analysis/);
  });

  it.each(['provider', 'model', 'provider_options'])(
    'Given loop analysis contains %s, When loading, Then validation rejects provider configuration',
    (field) => {
      writeRuntimeYaml(globalDir, [
        'version: 1',
        'loop_analysis:',
        '  enabled: true',
        `  ${field}: forbidden`,
      ]);

      expect(() => loadRuntimeProviderFileAt(join(globalDir, RUNTIME_PROVIDER_FILENAME)))
        .toThrow(/loop_analysis/);
    },
  );

  it('Given both files configure loop analysis, When resolving, Then the project section replaces the global section', () => {
    writeRuntimeYaml(globalDir, [
      'version: 1',
      'loop_analysis:',
      '  enabled: true',
      '  output: pr-comment',
    ]);
    writeRuntimeYaml(projectDir, [
      'version: 1',
      'loop_analysis:',
      '  enabled: false',
    ]);

    const resolved = resolveRuntimeProviderFile({ globalConfigDir: globalDir, projectConfigDir: projectDir });

    expect(resolved?.loop_analysis).toEqual({ enabled: false, output: 'file' });
  });

  it('Given only the global file configures loop analysis, When resolving, Then the global section is retained', () => {
    writeRuntimeYaml(globalDir, [
      'version: 1',
      'loop_analysis:',
      '  enabled: true',
      '  output: pr-comment',
    ]);
    writeRuntimeYaml(projectDir, ['version: 1']);

    const resolved = resolveRuntimeProviderFile({ globalConfigDir: globalDir, projectConfigDir: projectDir });

    expect(resolved?.loop_analysis).toEqual({ enabled: true, output: 'pr-comment' });
  });

  it('Given neither file present, When resolving, Then it returns undefined (C1)', () => {
    expect(resolveRuntimeProviderFile({ globalConfigDir: globalDir, projectConfigDir: projectDir })).toBeUndefined();
  });
});
