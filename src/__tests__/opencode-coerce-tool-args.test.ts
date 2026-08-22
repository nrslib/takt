import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoerceToolArgs } from '../infra/opencode/plugins/coerce-tool-args.js';

type Hook = (input: { tool: string }, output: { args: Record<string, unknown> }) => Promise<void>;

let coerce: Hook;
let workspace: string;
let existingFile: string;

beforeAll(async () => {
  const hooks = await CoerceToolArgs();
  coerce = hooks['tool.execute.before'];
  workspace = mkdtempSync(join(tmpdir(), 'takt-coerce-'));
  existingFile = join(workspace, 'target.ts');
  writeFileSync(existingFile, 'export const value = 1;\n');
});

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

const run = async (tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const output = { args };
  await coerce({ tool }, output);
  return output.args;
};

describe('CoerceToolArgs numeric coercion', () => {
  it('Given read offset and limit as integer-like strings When the hook runs Then they become numbers', async () => {
    expect(await run('read', { offset: '290.0', limit: '20' })).toEqual({ offset: 290, limit: 20 });
  });

  it('Given a bash timeout as an integer-like string When the hook runs Then it becomes a number', async () => {
    expect(await run('bash', { command: 'ls', timeout: '300000.0' })).toEqual({ command: 'ls', timeout: 300000 });
  });

  it.each([
    ['a fractional value', '1.9'],
    ['exponent notation', '1e3'],
    ['hexadecimal', '0x10'],
    ['a non-number', 'abc'],
    ['an empty string', ''],
    ['an unsafe integer', '9007199254740993'],
  ])('Given %s When the hook runs Then the value is left for OpenCode to reject', async (_label, value) => {
    expect(await run('read', { offset: value })).toEqual({ offset: value });
  });

  it('Given a tool without numeric arguments When the hook runs Then nothing changes', async () => {
    expect(await run('edit', { limit: '20' })).toEqual({ limit: '20' });
  });
});

describe('CoerceToolArgs filePath recovery', () => {
  it('Given a misspelled key holding an existing absolute path When the hook runs Then it is renamed to filePath', async () => {
    expect(await run('edit', { filepaath: existingFile, oldString: 'a', newString: 'b' }))
      .toEqual({ filePath: existingFile, oldString: 'a', newString: 'b' });
  });

  it('Given a "path" alias on read When the hook runs Then it is renamed to filePath', async () => {
    expect(await run('read', { path: existingFile })).toEqual({ filePath: existingFile });
  });

  it('Given filePath is already present When the hook runs Then aliases are left untouched', async () => {
    expect(await run('edit', { filePath: existingFile, path: '/other' }))
      .toEqual({ filePath: existingFile, path: '/other' });
  });

  it('Given an alias pointing at a missing file When the hook runs Then nothing is renamed', async () => {
    const missing = join(workspace, 'absent.ts');
    expect(await run('edit', { filepaath: missing })).toEqual({ filepaath: missing });
  });

  it('Given a relative path in an alias When the hook runs Then nothing is renamed', async () => {
    expect(await run('edit', { path: 'target.ts' })).toEqual({ path: 'target.ts' });
  });

  it('Given two aliases both pointing at existing files When the hook runs Then nothing is renamed', async () => {
    expect(await run('edit', { path: existingFile, filepath: existingFile }))
      .toEqual({ path: existingFile, filepath: existingFile });
  });

  it('Given a tool that does not take filePath When the hook runs Then aliases are left untouched', async () => {
    expect(await run('bash', { path: existingFile })).toEqual({ path: existingFile });
  });
});
