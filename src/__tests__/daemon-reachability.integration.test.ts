import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { daemonRules } from '../../scripts/daemon-lint-rules.mjs';
import { daemonEntries, daemonReachability, daemonProcessBoundaries } from '../../scripts/daemon-reachability.mjs';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'takt-daemon-graph-'));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    const file = join(root, path);
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, content);
  }
  return root;
}

describe('daemon transitive reachability', () => {
  it('follows value imports, re-exports, literal dynamic imports, and newly added common helpers', async () => {
    const root = await fixture({
      'src/features/daemon/main.ts': "import '../../shared/barrel.js';",
      'src/shared/barrel.ts': "export { value } from './common.js'; export * from './dynamic.js';",
      'src/shared/common.ts': "import { readFileSync } from 'node:fs'; export const value = readFileSync('file');",
      'src/shared/dynamic.ts': "await import('./new-helper.js');",
      'src/shared/new-helper.ts': 'export const added = true;',
    });
    const entries = await daemonEntries(root);
    const graph = await daemonReachability({ root, entries });
    expect(graph.issues).toEqual([]);
    expect(graph.files).toEqual([
      'src/features/daemon/main.ts', 'src/shared/barrel.ts', 'src/shared/common.ts', 'src/shared/dynamic.ts', 'src/shared/new-helper.ts',
    ]);
    const eslint = new ESLint({ cwd: root, overrideConfigFile: true, overrideConfig: [{
      files: ['**/*.ts'], languageOptions: { parser: tseslint.parser },
      plugins: { '@typescript-eslint': tseslint.plugin }, rules: daemonRules,
    }] });
    const results = await eslint.lintFiles(graph.files.map((file) => join(root, file)));
    expect(results.filter((result) => result.errorCount > 0).map((result) => result.filePath)).toEqual([join(root, 'src/shared/common.ts')]);
  });

  it('excludes fixtures/tests/dist from entry discovery and ignores type-only dependencies and external packages', async () => {
    const root = await fixture({
      'src/features/daemon/main.ts': [
        "import type { T } from '../../types/type.js';",
        "import { type T } from '../../types/inline.js';",
        "export type { T } from '../../types/export.js';",
        "export { type T } from '../../types/export-inline.js';",
        "import type { T as Fixture } from './fixtures/test.js';",
        "export type { T as Test } from './__tests__/test.js';",
        "import 'node:fs/promises';",
      ].join('\n'),
      ...Object.fromEntries(['type', 'inline', 'export', 'export-inline'].map((name) => [`src/types/${name}.ts`, 'export type T = string;'])),
      'src/features/daemon/__tests__/test.ts': 'export type T = string;',
      'src/features/daemon/fixtures/test.ts': 'export type T = string;',
      'src/features/daemon/dist/test.ts': 'export const compiled = true;',
      'dist/features/daemon/test.js': 'export const compiled = true;',
    });
    const graph = await daemonReachability({ root, entries: await daemonEntries(root) });
    expect(graph.files).toEqual(['src/features/daemon/main.ts']);
    expect(graph.issues).toEqual([]);
  });

  it.each(['fixtures', '__tests__', 'dist'])('reports value dependencies into %s as analysis errors, including transitive dependencies', async (directory) => {
    const dependency = `src/shared/${directory}/helper.ts`;
    for (const reference of [
      `import { value } from './${directory}/helper.js';`,
      `export { value } from './${directory}/helper.js';`,
      `await import('./${directory}/helper.js');`,
      `const helper = require('./${directory}/helper.js');`,
    ]) {
      const root = await fixture({
        'src/features/daemon/main.ts': "import '../../shared/common.js';",
        'src/shared/common.ts': reference,
        [dependency]: "import { readFileSync } from 'node:fs'; export const value = readFileSync('file');",
      });
      const entries = await daemonEntries(root);
      expect(entries).toEqual([join(root, 'src/features/daemon/main.ts')]);
      const graph = await daemonReachability({ root, entries });
      expect(graph.issues).toEqual([{
        file: 'src/shared/common.ts', line: 1, column: expect.any(Number),
        message: `Forbidden own value dependency: ${dependency}`,
      }]);
      expect(graph.files).toEqual(['src/features/daemon/main.ts', 'src/shared/common.ts']);
    }
  });

  it('includes daemon-only roots and workers but excludes independent turn and MCP runtimes', async () => {
    const root = await fixture({
      'src/app/daemon/index.ts': "import '../../features/daemon/start.js';",
      'src/core/daemon/contract.ts': 'export const protocol = 1;',
      'src/infra/daemon/store.ts': 'export const store = 1;',
      'src/features/daemon/lifecycle.ts': "import '../../shared/launcher.js';",
      'src/shared/launcher.ts': 'export const launcher = true;',
      'src/features/daemon/start.ts': "import { Worker } from 'node:worker_threads'; new Worker(new URL('./workers/entry.js', import.meta.url));",
      'src/features/daemon/workers/entry.ts': "import '../../../shared/worker-helper.js';",
      'src/shared/worker-helper.ts': 'export const value = 1;',
      'src/features/manager/turnRunner.ts': "import '../../shared/initialize.js';",
      'src/shared/initialize.ts': 'initialize();',
      'src/features/mcp/server.ts': "import '../../shared/mcp.js';",
      'src/shared/mcp.ts': 'export const value = 1;',
      'src/features/tasks/execute.ts': "import '../../shared/separate-run.js';",
      'src/shared/separate-run.ts': 'export const value = 1;',
    });
    const graph = await daemonReachability({ root, entries: await daemonEntries(root) });
    expect(graph.issues).toEqual([]);
    expect(graph.files).toContain('src/shared/worker-helper.ts');
    expect(graph.files).toContain('src/app/daemon/index.ts');
    expect(graph.files).toContain('src/core/daemon/contract.ts');
    expect(graph.files).toContain('src/infra/daemon/store.ts');
    expect(graph.files).not.toContain('src/shared/initialize.ts');
    expect(graph.files).not.toContain('src/features/daemon/lifecycle.ts');
    expect(graph.files).not.toContain('src/shared/mcp.ts');
    expect(graph.files).not.toContain('src/features/tasks/execute.ts');
    expect(graph.files).not.toContain('src/shared/separate-run.ts');
  });

  it('records non-literal imports, unresolved own modules, and unknown execution entries instead of silently skipping them', async () => {
    const root = await fixture({
      'src/features/daemon/start.ts': "import { spawn } from 'node:child_process'; await import(variable); await import('./missing.js'); new Worker(workerPath); fork(childPath); new Worker('code', { eval: true }); spawn(process.execPath, argv);",
    });
    const graph = await daemonReachability({ root, entries: await daemonEntries(root) });
    expect(graph.issues.map((issue) => issue.message)).toEqual([
      'Non-literal dynamic import', 'Unresolved own module: ./missing.js', 'Unknown own execution entry', 'Unknown own execution entry',
      'Unknown own execution entry', 'Unknown own execution entry (Node subprocess boundary)',
    ]);
  });

  it('follows aliased Worker and fork imports, so aliases cannot hide a new own entry', async () => {
    const root = await fixture({
      'src/features/daemon/start.ts': "import { Worker as W } from 'node:worker_threads'; import { fork as launch } from 'node:child_process'; new W(new URL('../../shared/work.js', import.meta.url)); launch(new URL('../../shared/child.js', import.meta.url));",
      'src/shared/work.ts': 'export const value = true;',
      'src/shared/child.ts': 'export const value = true;',
    });
    const graph = await daemonReachability({ root, entries: await daemonEntries(root) });
    expect(graph.issues).toEqual([]);
    expect(graph.files).toContain('src/shared/work.ts');
    expect(graph.files).toContain('src/shared/child.ts');
  });
  it('declares the absent turn entry and records only verified process launches as boundaries', async () => {
    const root = await fixture({
      'src/features/daemon/host.ts': "import { fork } from 'node:child_process'; fork(new URL('../../app/daemon-turn/index.js', import.meta.url)); spawnManagedProcess(process.execPath, [fileURLToPath(new URL('../../app/daemon-turn/index.js', import.meta.url))]);",
    });
    expect(daemonProcessBoundaries).toEqual([{ entry: 'src/app/daemon-turn/index.ts', owner: 'C', protocol: 'src/core/daemon/processProtocol.ts' }]);
    const graph = await daemonReachability({ root, entries: await daemonEntries(root) });
    expect(graph.issues).toEqual([]);
    expect(graph.boundaries).toHaveLength(2);
    expect(graph.boundaries.every((boundary) => boundary.entry === 'src/app/daemon-turn/index.ts')).toBe(true);
    expect(graph.files).toEqual(['src/features/daemon/host.ts']);
  });

  it('keeps synchronous child internals outside the graph until a value import reaches them', async () => {
    const root = await fixture({
      'src/features/daemon/host.ts': "import { fork } from 'node:child_process'; fork(new URL('../../app/daemon-turn/index.js', import.meta.url));",
      'src/app/daemon-turn/index.ts': "import '../../features/daemonTurn/runtime.js';",
      'src/features/daemonTurn/runtime.ts': "import { readFileSync } from 'node:fs'; readFileSync('file');",
    });
    const entries = await daemonEntries(root);
    const before = await daemonReachability({ root, entries });
    expect(before.issues).toEqual([]);
    expect(before.files).not.toContain('src/features/daemonTurn/runtime.ts');
    await writeFile(join(root, 'src/features/daemon/host.ts'), "import '../../app/daemon-turn/index.js';");
    const after = await daemonReachability({ root, entries });
    expect(after.files).toContain('src/features/daemonTurn/runtime.ts');
    const eslint = new ESLint({ cwd: root, overrideConfigFile: true, overrideConfig: [{
      files: ['**/*.ts'], languageOptions: { parser: tseslint.parser },
      plugins: { '@typescript-eslint': tseslint.plugin }, rules: daemonRules,
    }] });
    const results = await eslint.lintFiles(after.files.map((file) => join(root, file)));
    expect(results.filter((result) => result.errorCount > 0).map((result) => result.filePath))
      .toEqual([join(root, 'src/features/daemonTurn/runtime.ts')]);
  });

  it('enforces blocking API and unobserved promise errors through the normal repository ESLint configuration', async () => {
    const eslint = new ESLint({ cwd: process.cwd() });
    const results = await eslint.lintText("import { readFileSync } from 'node:fs'; readFileSync('file'); Promise.resolve();", {
      filePath: join(process.cwd(), 'src/features/daemon/runDaemon.ts'),
    });
    expect(results[0]!.messages.map((message) => message.ruleId)).toEqual(expect.arrayContaining([
      '@typescript-eslint/no-restricted-imports', '@typescript-eslint/no-floating-promises',
    ]));
  });

  it('does not trust relative cwd paths, arbitrary URL bases, or Worker aliases as turn process boundaries', async () => {
    const root = await fixture({
      'src/features/daemon/host.ts': "import { fork, spawn } from 'node:child_process'; import { Worker as W } from 'node:worker_threads'; fork(new URL('../../app/daemon-turn/index.js', arbitraryBase)); spawn(process.execPath, ['../../app/daemon-turn/index.js']); new W(new URL('../../app/daemon-turn/index.js', import.meta.url));",
      'src/app/daemon-turn/index.ts': "import '../../features/daemonTurn/runtime.js';",
      'src/features/daemonTurn/runtime.ts': 'export const child = true;',
    });
    const graph = await daemonReachability({ root, entries: await daemonEntries(root) });
    expect(graph.boundaries).toEqual([]);
    expect(graph.issues.map((issue) => issue.message)).toEqual(['Unknown own execution entry', 'Unknown own execution entry (Node subprocess boundary)']);
    expect(graph.files).toContain('src/features/daemonTurn/runtime.ts');
  });

});
