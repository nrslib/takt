import { describe, expect, it } from 'vitest';
// New module under test (implemented in the following `implement` step).
import {
  redactMcpServerForLog,
  buildMcpServerIdentity,
} from '../infra/config/runtime-provider/mcp-schema.js';

/**
 * Contracts covered (see plan.md 完了契約):
 * - `MCP-ENV` (要件17,75)
 *   - 環境変数と header の秘密値はログへ出力しない
 *   - session/cache/pool の識別情報やログへ token/header 値/環境変数の解決値を含めない
 *
 * 反例:
 *   - ログ出力に ${...} 解決値（env, header）を含める
 *   - identity に env 解決値・header 値を含める
 */

describe('redactMcpServerForLog (MCP-ENV secret redaction)', () => {
  it('Given a stdio server with env, When redacted for log, Then env values are replaced with placeholder', () => {
    const result = redactMcpServerForLog({
      type: 'stdio',
      command: 'srv',
      env: { API_TOKEN: 'secret-value', OTHER: 'other' },
    });
    expect(result).not.toHaveProperty('env.API_TOKEN', 'secret-value');
    expect(JSON.stringify(result)).not.toContain('secret-value');
    expect(JSON.stringify(result)).not.toContain('other');
  });

  it('Given an http server with Authorization header, When redacted for log, Then the header value is masked', () => {
    const result = redactMcpServerForLog({
      type: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer secret-token' },
    });
    expect(JSON.stringify(result)).not.toContain('secret-token');
    // url is not a secret per se but header is.
  });

  it('Given an sse server with headers, When redacted for log, Then header values are masked', () => {
    const result = redactMcpServerForLog({
      type: 'sse',
      url: 'http://legacy.local/sse',
      headers: { 'X-Api-Key': 'hidden-key' },
    });
    expect(JSON.stringify(result)).not.toContain('hidden-key');
  });

  it('Given a stdio server with args containing secrets, When redacted for log, Then args are preserved (args are not secret)', () => {
    const result = redactMcpServerForLog({
      type: 'stdio',
      command: 'srv',
      args: ['--flag', 'value'],
    });
    expect(result).toEqual({ type: 'stdio', command: 'srv', args: ['--flag', 'value'] });
  });

  it('Given a server with no secrets, When redacted for log, Then it is returned unchanged (shape preserved)', () => {
    const result = redactMcpServerForLog({
      type: 'stdio',
      command: 'srv',
    });
    expect(result).toEqual({ type: 'stdio', command: 'srv' });
  });
});

describe('buildMcpServerIdentity (MCP-ENV identity excludes secrets)', () => {
  it('Given two servers with same name+transport but different secret env, Then identity is equal (要件75)', () => {
    const idA = buildMcpServerIdentity('common', { type: 'stdio', command: 'srv', env: { TOKEN: 'a' } });
    const idB = buildMcpServerIdentity('common', { type: 'stdio', command: 'srv', env: { TOKEN: 'b' } });
    expect(idA).toBe(idB);
  });

  it('Given two servers with different transport, Then identity differs', () => {
    const idStdio = buildMcpServerIdentity('common', { type: 'stdio', command: 'srv' });
    const idHttp = buildMcpServerIdentity('common', { type: 'http', url: 'https://x' });
    expect(idStdio).not.toBe(idHttp);
  });

  it('Given two servers with different names, Then identity differs', () => {
    const idA = buildMcpServerIdentity('common', { type: 'stdio', command: 'srv' });
    const idB = buildMcpServerIdentity('github', { type: 'stdio', command: 'srv' });
    expect(idA).not.toBe(idB);
  });

  it('Given a server with header secrets, Then identity does NOT contain the header value', () => {
    const id = buildMcpServerIdentity('common', {
      type: 'http',
      url: 'https://example.com',
      headers: { Authorization: 'Bearer secret' },
    });
    expect(id).not.toContain('secret');
    expect(id).not.toContain('Bearer');
  });

  it('Given a server with env secrets, Then identity does NOT contain the env value', () => {
    const id = buildMcpServerIdentity('common', {
      type: 'stdio',
      command: 'srv',
      env: { TOKEN: 'secret-value' },
    });
    expect(id).not.toContain('secret-value');
  });
});