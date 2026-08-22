import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// New module under test (implemented in the following `implement` step).
import {
  resolveRuntimeProviderFile,
} from '../infra/config/runtime-provider/loader.js';
import { RUNTIME_PROVIDER_FILENAME } from '../infra/config/runtime-provider/constants.js';

/**
 * Contracts covered (see plan.md 完了契約):
 * - `MCP-MERGE` (要件14,102)
 *   - global/project で同名 server は project 側で全体置換（field 単位 merge しない）
 *   - `mcp` セクション全体でも project 側が存在すれば project 採用（`defaults`/`targets` 含む）
 *
 * 反例:
 *   - 同名 server の `command` だけ混ぜる → 結果が project 全体にならない
 *   - `defaults` を field 単位で merge する → reject
 *
 * 既存 `mergeProviderSections` と同 pattern だが `mcp` セクション向け。
 */

let root: string;
let globalDir: string;
let projectDir: string;

function writeRuntimeYaml(dir: string, lines: string[]): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, RUNTIME_PROVIDER_FILENAME), lines.join('\n'), 'utf-8');
}

describe('runtime-provider loader — mcp merge (MCP-MERGE)', () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'takt-runtime-mcp-merge-'));
    globalDir = join(root, 'global-.takt');
    projectDir = join(root, 'project-.takt');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('Given only the global mcp, When resolving, Then the global mcp is returned', () => {
    writeRuntimeYaml(globalDir, [
      'version: 1',
      'mcp:',
      '  servers:',
      '    common:',
      '      command: global-srv',
      '  defaults:',
      '    servers:',
      '      - common',
    ]);
    const resolved = resolveRuntimeProviderFile({ globalConfigDir: globalDir, projectConfigDir: projectDir });
    expect(resolved?.mcp?.servers?.common).toMatchObject({ command: 'global-srv' });
    expect(resolved?.mcp?.defaults?.servers).toEqual(['common']);
  });

  it('Given only the project mcp, When resolving, Then the project mcp is returned', () => {
    writeRuntimeYaml(projectDir, [
      'version: 1',
      'mcp:',
      '  servers:',
      '    common:',
      '      command: project-srv',
      '  defaults:',
      '    servers:',
      '      - common',
    ]);
    const resolved = resolveRuntimeProviderFile({ globalConfigDir: globalDir, projectConfigDir: projectDir });
    expect(resolved?.mcp?.servers?.common).toMatchObject({ command: 'project-srv' });
  });

  it('Given global and project same-name servers, When resolving, Then project replaces the whole server (no field-level merge)', () => {
    // global `common` carries an `args` field that project's `common` omits.
    writeRuntimeYaml(globalDir, [
      'version: 1',
      'mcp:',
      '  servers:',
      '    common:',
      '      command: global-srv',
      '      args:',
      '        - --global-only',
    ]);
    writeRuntimeYaml(projectDir, [
      'version: 1',
      'mcp:',
      '  servers:',
      '    common:',
      '      command: project-srv',
    ]);
    const resolved = resolveRuntimeProviderFile({ globalConfigDir: globalDir, projectConfigDir: projectDir });
    // same-name server fully replaced: project command wins AND the global-only `args` is gone.
    expect(resolved?.mcp?.servers?.common).toMatchObject({ command: 'project-srv' });
    expect((resolved?.mcp?.servers?.common as { args?: string[] } | undefined)?.args).toBeUndefined();
  });

  it('Given global and project disjoint servers, When resolving, Then project replaces the whole servers map', () => {
    writeRuntimeYaml(globalDir, [
      'version: 1',
      'mcp:',
      '  servers:',
      '    global-only:',
      '      command: g-srv',
    ]);
    writeRuntimeYaml(projectDir, [
      'version: 1',
      'mcp:',
      '  servers:',
      '    project-only:',
      '      command: p-srv',
    ]);
    const resolved = resolveRuntimeProviderFile({ globalConfigDir: globalDir, projectConfigDir: projectDir });
    // When both files carry `mcp`, the project's whole `mcp` replaces global's;
    // global `global-only` disappears unless project also defines it.
    expect(resolved?.mcp?.servers?.['project-only']).toMatchObject({ command: 'p-srv' });
    expect(resolved?.mcp?.servers?.['global-only']).toBeUndefined();
  });

  it('Given project mcp.targets but no global targets, When resolving, Then project targets survive', () => {
    writeRuntimeYaml(projectDir, [
      'version: 1',
      'mcp:',
      '  servers:',
      '    a:',
      '      command: x',
      '  targets:',
      '    personas:',
      '      rm:',
      '        servers:',
      '          - a',
    ]);
    const resolved = resolveRuntimeProviderFile({ globalConfigDir: globalDir, projectConfigDir: projectDir });
    expect(resolved?.mcp?.targets?.personas?.rm?.servers).toEqual(['a']);
  });

  it('Given both carry mcp.targets, When resolving, Then project targets replaces global targets (no deep merge)', () => {
    writeRuntimeYaml(globalDir, [
      'version: 1',
      'mcp:',
      '  servers:',
      '    a:',
      '      command: x',
      '    b:',
      '      command: y',
      '  targets:',
      '    personas:',
      '      rm:',
      '        servers:',
      '          - a',
    ]);
    writeRuntimeYaml(projectDir, [
      'version: 1',
      'mcp:',
      '  servers:',
      '    a:',
      '      command: x',
      '    b:',
      '      command: y',
      '  targets:',
      '    tags:',
      '      github:',
      '        servers:',
      '          - b',
    ]);
    const resolved = resolveRuntimeProviderFile({ globalConfigDir: globalDir, projectConfigDir: projectDir });
    // project's whole mcp replaces global's; project targets only contains tags, not personas.
    expect(resolved?.mcp?.targets?.tags?.github?.servers).toEqual(['b']);
    expect(resolved?.mcp?.targets?.personas).toBeUndefined();
  });

  it('Given project mcp missing but global mcp present, When resolving, Then global mcp survives', () => {
    writeRuntimeYaml(globalDir, [
      'version: 1',
      'mcp:',
      '  servers:',
      '    a:',
      '      command: x',
      '  defaults:',
      '    servers:',
      '      - a',
    ]);
    writeRuntimeYaml(projectDir, [
      'version: 1',
    ]);
    const resolved = resolveRuntimeProviderFile({ globalConfigDir: globalDir, projectConfigDir: projectDir });
    expect(resolved?.mcp?.servers?.a).toMatchObject({ command: 'x' });
    expect(resolved?.mcp?.defaults?.servers).toEqual(['a']);
  });

  it('Given both mcp and provider sections, When resolving, Then they are resolved independently', () => {
    writeRuntimeYaml(globalDir, [
      'version: 1',
      'provider:',
      '  defaults:',
      '    profile: g',
      '  profiles:',
      '    g:',
      '      provider: mock',
      '      model: g-model',
      'mcp:',
      '  servers:',
      '    a:',
      '      command: g-srv',
    ]);
    writeRuntimeYaml(projectDir, [
      'version: 1',
      'provider:',
      '  defaults:',
      '    profile: g',
      '  profiles:',
      '    g:',
      '      provider: codex',
      '      model: p-model',
      'mcp:',
      '  servers:',
      '    a:',
      '      command: p-srv',
    ]);
    const resolved = resolveRuntimeProviderFile({ globalConfigDir: globalDir, projectConfigDir: projectDir });
    expect(resolved?.provider?.profiles?.g?.model).toBe('p-model');
    expect(resolved?.mcp?.servers?.a).toMatchObject({ command: 'p-srv' });
  });
});
