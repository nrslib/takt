import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReadonlyDirectoryGuard } from '../infra/opencode/plugins/readonly-directory-guard.js';

const temporaryDirectories: string[] = [];

function createDirectories(): { workspace: string; reference: string } {
  const root = mkdtempSync(join(tmpdir(), 'takt-opencode-readonly-guard-'));
  temporaryDirectories.push(root);
  const workspace = join(root, 'workspace');
  const reference = join(root, 'reference');
  mkdirSync(workspace);
  mkdirSync(reference);
  writeFileSync(join(reference, 'api.ts'), 'export const api = true;');
  symlinkSync(reference, join(workspace, 'reference-link'), 'dir');
  return { workspace, reference };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('OpenCode v1 read-only directory guard', () => {
  it.each(['edit', 'write'] as const)('blocks %s requests for absolute and relative reference paths', async (tool) => {
    const { workspace, reference } = createDirectories();
    const plugin = await ReadonlyDirectoryGuard(
      { directory: workspace },
      { readonlyDirectories: [reference] },
    );
    const before = plugin['tool.execute.before'];

    await expect(before({ tool }, { args: { filePath: join(reference, 'api.ts') } }))
      .rejects.toThrow('cannot modify a read-only directory');
    await expect(before({ tool }, { args: { filePath: '../reference/api.ts' } }))
      .rejects.toThrow('cannot modify a read-only directory');
    await expect(before({ tool }, { args: { filePath: 'reference-link/api.ts' } }))
      .rejects.toThrow('cannot modify a read-only directory');
  });

  it('allows workspace edits while blocking patch tools whose targets are bundled', async () => {
    const { workspace, reference } = createDirectories();
    const plugin = await ReadonlyDirectoryGuard(
      { directory: workspace },
      { readonlyDirectories: [reference] },
    );
    const before = plugin['tool.execute.before'];

    await expect(before({ tool: 'edit' }, { args: { filePath: join(workspace, 'main.ts') } }))
      .resolves.toBeUndefined();
    await expect(before({ tool: 'write' }, { args: { filePath: 'main.ts' } }))
      .resolves.toBeUndefined();
    await expect(before({ tool: 'apply_patch' }, { args: { patchText: 'patch' } }))
      .rejects.toThrow('patch tools are disabled');
    await expect(before({ tool: 'patch' }, { args: { patchText: 'patch' } }))
      .rejects.toThrow('patch tools are disabled');
  });
});
