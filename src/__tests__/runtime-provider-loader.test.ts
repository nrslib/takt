import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// New module under test (implemented in the following `implement` step).
import {
  loadRuntimeProviderFileAt,
  resolveRuntimeProviderFile,
} from '../infra/config/runtime-provider/loader.js';

/**
 * Contracts covered (see plan.md 完了契約):
 * - C1 fixed two paths (~/.takt/runtime.yaml, <project>/.takt/runtime.yaml), schema-validated
 * - C3 project settings take priority over global
 * - C2 same-name profile is replaced wholesale (no field-level merge)
 *
 * The loader takes explicit directories (no implicit homedir/cwd fallback), matching
 * the "解決責務の一元化 / pass paths from above" policy.
 */

const root = join(tmpdir(), 'takt-runtime-provider-loader');
const globalDir = join(root, 'global-.takt');
const projectDir = join(root, 'project-.takt');

function writeRuntimeYaml(dir: string, lines: string[]): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'runtime.yaml'), lines.join('\n'), 'utf-8');
}

describe('runtime-provider loader', () => {
  beforeEach(() => {
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('Given a missing file, When loading a single path, Then it returns undefined (C1)', () => {
    mkdirSync(globalDir, { recursive: true });
    expect(loadRuntimeProviderFileAt(join(globalDir, 'runtime.yaml'))).toBeUndefined();
  });

  it('Given an invalid runtime.yaml, When loading, Then it throws (schema validation, C1)', () => {
    writeRuntimeYaml(globalDir, ['version: 2']);
    expect(() => loadRuntimeProviderFileAt(join(globalDir, 'runtime.yaml'))).toThrow();
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
    const resolved: any = resolveRuntimeProviderFile({ globalConfigDir: globalDir, projectConfigDir: projectDir });
    expect(resolved?.provider?.profiles?.g?.model).toBe('global-model');
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
    const resolved: any = resolveRuntimeProviderFile({ globalConfigDir: globalDir, projectConfigDir: projectDir });
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
      '  profiles:',
      '    shared:',
      '      provider: codex',
      '      model: project-model',
      '    project-only:',
      '      provider: mock',
      '      model: added',
    ]);
    const resolved: any = resolveRuntimeProviderFile({ globalConfigDir: globalDir, projectConfigDir: projectDir });

    // same-name profile fully replaced: project fields win AND the global-only `options` is gone.
    expect(resolved?.provider?.profiles?.shared?.model).toBe('project-model');
    expect(resolved?.provider?.profiles?.shared?.options).toBeUndefined();
    // disjoint profiles from both layers are retained.
    expect(resolved?.provider?.profiles?.['global-only']?.model).toBe('keep-me');
    expect(resolved?.provider?.profiles?.['project-only']?.model).toBe('added');
  });

  it('Given both files carry `targets`, When resolving, Then the whole targets section is replaced by project (no deep merge, C2)', () => {
    writeRuntimeYaml(globalDir, [
      'version: 1',
      'provider:',
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
      '  profiles:',
      '    p:',
      '      provider: mock',
      '      model: m',
      '  targets:',
      '    tags:',
      '      high-stakes:',
      '        profile: p',
    ]);
    const resolved: any = resolveRuntimeProviderFile({ globalConfigDir: globalDir, projectConfigDir: projectDir });
    // section-level replacement: project targets wins wholesale, global `personas` disappears.
    expect(resolved?.provider?.targets?.tags?.['high-stakes']?.profile).toBe('p');
    expect(resolved?.provider?.targets?.personas).toBeUndefined();
  });

  it('Given project lacks `defaults` but global has it, When resolving, Then defaults falls back to global (C3)', () => {
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
    const resolved: any = resolveRuntimeProviderFile({ globalConfigDir: globalDir, projectConfigDir: projectDir });
    // defaults is absent in project, so the global defaults survives.
    expect(resolved?.provider?.defaults?.profile).toBe('g-default');
    // disjoint profiles from both layers are retained.
    expect(resolved?.provider?.profiles?.['g-default']?.model).toBe('m');
    expect(resolved?.provider?.profiles?.p?.model).toBe('project-model');
  });

  it('Given both files carry `auto_routing`, When resolving, Then project auto_routing replaces global (C3)', () => {
    writeRuntimeYaml(globalDir, [
      'version: 1',
      'provider:',
      '  auto_routing:',
      '    strategy: global-strategy',
    ]);
    writeRuntimeYaml(projectDir, [
      'version: 1',
      'provider:',
      '  auto_routing:',
      '    strategy: project-strategy',
    ]);
    const resolved: any = resolveRuntimeProviderFile({ globalConfigDir: globalDir, projectConfigDir: projectDir });
    expect(resolved?.provider?.auto_routing?.strategy).toBe('project-strategy');
  });

  it('Given neither file present, When resolving, Then it returns undefined (C1)', () => {
    expect(resolveRuntimeProviderFile({ globalConfigDir: globalDir, projectConfigDir: projectDir })).toBeUndefined();
  });
});
