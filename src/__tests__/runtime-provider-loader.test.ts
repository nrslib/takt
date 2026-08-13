import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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

describe('runtime-provider loader', () => {
  beforeEach(() => {
    // Unique per-run directory: a fixed tmpdir path would let two concurrent runs of this
    // file delete each other's fixtures.
    root = mkdtempSync(join(tmpdir(), 'takt-runtime-provider-loader-'));
    globalDir = join(root, 'global-.takt');
    projectDir = join(root, 'project-.takt');
  });

  afterEach(() => {
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

  it('Given neither file present, When resolving, Then it returns undefined (C1)', () => {
    expect(resolveRuntimeProviderFile({ globalConfigDir: globalDir, projectConfigDir: projectDir })).toBeUndefined();
  });
});
