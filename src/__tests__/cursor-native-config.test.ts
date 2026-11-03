import { beforeEach, describe, expect, it, vi } from 'vitest';

const readFile = vi.hoisted(() => vi.fn());
vi.mock('node:fs/promises', () => ({ readFile }));

import { cursorApprovalKey, readCursorProjectServers, relocateCursorProjectServer } from '../infra/providers/mcp/cursor-native-config.js';

describe('Cursor native project configuration', () => {
  beforeEach(() => { readFile.mockReset(); });

  it('reads native JSONC without materializing referenced header values', async () => {
    readFile.mockResolvedValue('{ // shared config\n "mcpServers": { "github": { "url": "https://example.test", "headers": { "Authorization": "${env:ACCESS}" }, }, }, }');
    const servers = await readCursorProjectServers('/project', { ACCESS: 'synthetic-access' });
    expect(servers.github).toEqual({ url: 'https://example.test', headers: { Authorization: '${env:ACCESS}' } });
  });

  it.each(['{"mcpServers":{"broken":{"command":3}}}', 'not JSON'])('preserves native rejection of an invalid config: %s', async (input) => {
    readFile.mockResolvedValue(input);
    expect(await readCursorProjectServers('/project', {})).toEqual({});
  });

  it('preserves native handling of an absent project config', async () => {
    readFile.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    expect(await readCursorProjectServers('/project', {})).toEqual({});
  });

  it('preserves comment markers, escaped quotes and trailing-comma text inside JSONC strings', async () => {
    const server = { url: 'https://example.test/*path*/', headers: { Note: 'quote " and comma ,} // literal' } };
    readFile.mockResolvedValue('\uFEFF{/* block */ "mcpServers": {"github":' + JSON.stringify(server) + ',},}');
    expect(await readCursorProjectServers('/project', {})).toEqual({ github: server });
  });

  it('matches approval identities after native field normalization and environment expansion', () => {
    const referenced = { headers: { Authorization: '${env:ACCESS}' }, url: 'https://example.test', ignored: 'not in native schema' };
    const literal = { url: 'https://example.test', headers: { Authorization: 'synthetic-access' } };
    expect(cursorApprovalKey('github', referenced, '/project', { ACCESS: 'synthetic-access' }))
      .toBe(cursorApprovalKey('github', literal, '/project', {}));
    expect(cursorApprovalKey('github', literal, '/other-project', {}))
      .not.toBe(cursorApprovalKey('github', literal, '/project', {}));
  });

  it('does not reuse approval identity for changed arguments', () => {
    expect(cursorApprovalKey('github', { command: 'node', args: ['a.js'] }, '/project', {}))
      .not.toBe(cursorApprovalKey('github', { command: 'node', args: ['b.js'] }, '/project', {}));
  });

  it('keeps project-relative stdio execution at the original working directory', () => {
    expect(relocateCursorProjectServer({ command: './bin/server', args: ['service.js'] }, '/project/subdir', {}))
      .toEqual({ command: './bin/server', args: ['service.js'], cwd: '/project/subdir' });
    expect(relocateCursorProjectServer({ command: 'node', cwd: 'services' }, '/project', {}))
      .toEqual({ command: 'node', cwd: '/project/services' });
  });

  it('retains native cwd references and respects server-local environment', () => {
    const server = { command: 'node', cwd: '${ROOT}', env: { ROOT: '/services' } };
    expect(relocateCursorProjectServer(server, '/project', {})).toEqual(server);
    const referenced = { command: 'node', cwd: '${env:ROOT}' };
    expect(relocateCursorProjectServer(referenced, '/project', { ROOT: '/services' })).toEqual(referenced);
  });

  it('keeps HTTP configuration unchanged when relocating stdio servers', () => {
    const server = { url: 'https://example.test' };
    expect(relocateCursorProjectServer(server, '/project', {})).toEqual(server);
  });
});
