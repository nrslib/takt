import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, realpathSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCursorMcpAdapter } from '../infra/providers/mcp/cursor.js';
import { cursorApprovalKey } from '../infra/providers/mcp/cursor-native-config.js';
import { interpolateMcpEnv } from '../infra/config/runtime-provider/mcp-schema.js';

let root: string;
let workspace: string;
let source: string;
let environment: Record<string, string>;
const key = (path: string) => path.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
const read = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8')) as unknown;

function servers(partial: boolean, reference = true) {
  const datadog = interpolateMcpEnv({ type: 'http', url: 'https://example.test', headers: {
    Authorization: reference ? 'Token ${env:X}' : 'fixed-value',
  } }, { X: 'synthetic-reference' });
  const values = { datadog, ...(partial ? { echo: { command: 'node', args: ['runtime.js'] } } : {}) };
  return { enabled: true, servers: values, serverNames: Object.keys(values), identity: 'test' };
}

describe('Cursor MCP settings preparation', () => {
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'cursor-settings-')));
    workspace = join(root, 'workspace');
    mkdirSync(join(workspace, '.git'), { recursive: true });
    mkdirSync(join(workspace, '.cursor'));
    source = join(root, 'source', 'projects', key(workspace));
    mkdirSync(source, { recursive: true });
    environment = { HOME: root, USERPROFILE: root, CURSOR_DATA_DIR: join(root, 'source') };
    for (const [name, value] of Object.entries(environment)) vi.stubEnv(name, value);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

  it('keeps the original workspace and its native management state for all-excluded runs', async () => {
    const files = {
      'mcp-disabled.json': ['already-disabled'], 'mcp-approvals.json': ['existing-approval'],
      'mcp-group-selections.json': { group: 'github' },
      'mcp-auth.json': { datadog: { tokens: { access_token: 'excluded-auth' } }, github: { tokens: { access_token: 'retained-auth' } } },
    };
    for (const [file, value] of Object.entries(files)) writeFileSync(join(source, file), JSON.stringify(value));
    const nested = join(workspace, 'subdir'); mkdirSync(nested);
    const prepared = await createCursorMcpAdapter().prepare(servers(false), { cwd: nested, childProcessEnv: environment });
    const data = prepared.env?.CURSOR_DATA_DIR;
    try {
      expect(data).toBeDefined();
      expect(prepared.configRoot).toBeUndefined();
      const target = join(data!, 'projects', key(workspace));
      expect(read(join(target, 'mcp-disabled.json'))).toEqual(['already-disabled', 'datadog']);
      expect(read(join(target, 'mcp-approvals.json'))).toEqual(['existing-approval']);
      expect(read(join(target, 'mcp-group-selections.json'))).toEqual({ group: 'github' });
      expect(read(join(target, 'mcp-auth.json'))).toEqual({ github: { tokens: { access_token: 'retained-auth' } } });
      if (process.platform !== 'win32') expect(statSync(join(target, 'mcp-auth.json')).mode & 0o777).toBe(0o600);
      for (const [file, value] of Object.entries(files)) expect(read(join(source, file))).toEqual(value);
    } finally { await prepared.dispose(); }
    expect(existsSync(data!)).toBe(false);
    await prepared.dispose();
  });

  it.each(['approved', 'unapproved', 'stale'] as const)('preserves %s project approval while retaining runtime definitions', async (state) => {
    const original = { command: 'node', args: ['service-a.js'] };
    const current = state === 'stale' ? { ...original, args: ['service-b.js'] } : original;
    const config = JSON.stringify({ mcpServers: { github: current } });
    writeFileSync(join(workspace, '.cursor', 'mcp.json'), config);
    const approvals = state === 'unapproved' ? [] : [cursorApprovalKey('github', original, workspace, environment)];
    writeFileSync(join(source, 'mcp-approvals.json'), JSON.stringify(approvals));
    const prepared = await createCursorMcpAdapter().prepare(servers(true), { cwd: workspace, childProcessEnv: environment });
    try {
      const configRoot = prepared.configRoot!;
      const targetServers = (read(join(configRoot, '.cursor', 'mcp.json')) as { mcpServers: Record<string, unknown> }).mcpServers;
      expect(targetServers).toEqual({ github: { ...current, cwd: workspace }, echo: { command: 'node', args: ['runtime.js'] } });
      const keys = read(join(prepared.env!.CURSOR_DATA_DIR!, 'projects', key(configRoot), 'mcp-approvals.json'));
      expect(keys).toEqual(state === 'approved' ? [cursorApprovalKey('github', targetServers.github, configRoot, environment)] : []);
      expect(readFileSync(join(workspace, '.cursor', 'mcp.json'), 'utf8')).toBe(config);
      expect(read(join(source, 'mcp-approvals.json'))).toEqual(approvals);
    } finally { await prepared.dispose(); }
  });

  it('does not transfer project credentials to a runtime server with the same name', async () => {
    writeFileSync(join(workspace, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { echo: { url: 'https://native.test' } } }));
    writeFileSync(join(source, 'mcp-auth.json'), JSON.stringify({ echo: { tokens: { access_token: 'native-echo-secret' } } }));
    const prepared = await createCursorMcpAdapter().prepare(servers(true), { cwd: workspace, childProcessEnv: environment });
    try {
      expect(read(join(prepared.env!.CURSOR_DATA_DIR!, 'projects', key(prepared.configRoot!), 'mcp-auth.json'))).toEqual({});
    } finally { await prepared.dispose(); }
  });

  it('does not apply exclusion management to literal headers or an originally empty assignment', async () => {
    for (const input of [servers(false, false), { enabled: false, servers: {}, serverNames: [], identity: 'empty' }]) {
      const prepared = await createCursorMcpAdapter().prepare(input, { cwd: workspace, childProcessEnv: environment });
      try { expect(prepared.env).toBeUndefined(); expect(prepared.excludedServerNames).toBeUndefined(); }
      finally { await prepared.dispose(); }
    }
  });

  it.each([false, true])('removes owned artifacts when management parsing fails (partial=%s)', async (partial) => {
    const temporary = join(root, 'tmp'); mkdirSync(temporary);
    vi.stubEnv('TMPDIR', temporary); vi.stubEnv('TMP', temporary); vi.stubEnv('TEMP', temporary);
    writeFileSync(join(source, 'mcp-auth.json'), '{synthetic-auth-secret');
    await expect(createCursorMcpAdapter().prepare(servers(partial), { cwd: workspace, childProcessEnv: environment }))
      .rejects.toThrow('Failed to read Cursor MCP management data');
    expect(readdirSync(temporary)).toEqual([]);
  });
});
