import { describe, expect, it } from 'vitest';
// New module under test (implemented in the following `implement` step).
import {
  interpolateMcpEnv,
  redactMcpServerForLog,
  buildMcpServerIdentity,
} from '../infra/config/runtime-provider/mcp-schema.js';
import type { McpServerConfig } from '../core/models/workflow-provider-options.js';

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
  it('Given an interpolated command/args/url, When redacted for log, Then resolved secret values are absent', () => {
    const stdio = interpolateMcpEnv({
      type: 'stdio',
      command: 'mcp-${MCP_LOG_SECRET}',
      args: ['--token', '${MCP_LOG_SECRET}'],
    }, { MCP_LOG_SECRET: 'resolved-secret' });
    const remote = interpolateMcpEnv({
      type: 'http',
      url: 'https://example.com/${MCP_LOG_SECRET}',
      headers: { Authorization: 'Bearer ${MCP_LOG_SECRET}' },
    }, { MCP_LOG_SECRET: 'resolved-secret' });

    expect(JSON.stringify(redactMcpServerForLog(stdio))).not.toContain('resolved-secret');
    expect(JSON.stringify(redactMcpServerForLog(remote))).not.toContain('resolved-secret');
  });

  it('Given copied interpolated server configs, When redacted for log, Then copies retain the safe source association', () => {
    const resolved = interpolateMcpEnv({
      type: 'stdio',
      command: 'mcp-${MCP_COPY_SECRET}',
      args: ['--token', '${MCP_COPY_SECRET}'],
    }, { MCP_COPY_SECRET: 'copied-secret' });
    const copies: McpServerConfig[] = [
      { ...resolved },
      JSON.parse(JSON.stringify(resolved)) as McpServerConfig,
    ];

    for (const copy of copies) {
      expect(JSON.stringify(redactMcpServerForLog(copy))).not.toContain('copied-secret');
      expect(buildMcpServerIdentity('common', copy)).toBe(
        buildMcpServerIdentity('common', resolved),
      );
      expect(buildMcpServerIdentity('common', copy)).not.toContain('copied-secret');
    }
  });

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

  it('Given literal URL credentials and authentication args, When redacted for log, Then both are masked', () => {
    const remote = redactMcpServerForLog({
      type: 'http',
      url: 'https://user:literal-password@example.com/mcp',
    });
    const stdio = redactMcpServerForLog({
      type: 'stdio',
      command: 'srv',
      args: ['--token', 'literal-token', '--mode', 'safe'],
    });
    expect(JSON.stringify(remote)).not.toContain('literal-password');
    expect(stdio).toEqual({
      type: 'stdio',
      command: 'srv',
      args: ['--token', '<redacted>', '--mode', 'safe'],
    });
  });

  it('Given an sse server with headers, When redacted for log, Then header values are masked', () => {
    const result = redactMcpServerForLog({
      type: 'sse',
      url: 'http://legacy.local/sse',
      headers: { 'X-Api-Key': 'hidden-key' },
    });
    expect(JSON.stringify(result)).not.toContain('hidden-key');
  });

  it('Given a stdio server with non-authentication args, When redacted for log, Then those args are preserved', () => {
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

  it('Given interpolated command/args with a rotated secret, Then identity is stable', () => {
    const raw = {
      type: 'stdio' as const,
      command: 'mcp-${MCP_IDENTITY_SECRET}',
      args: ['--token', '${MCP_IDENTITY_SECRET}'],
    };
    const idA = buildMcpServerIdentity(
      'common',
      interpolateMcpEnv(raw, { MCP_IDENTITY_SECRET: 'first-secret' }),
    );
    const idB = buildMcpServerIdentity(
      'common',
      interpolateMcpEnv(raw, { MCP_IDENTITY_SECRET: 'rotated-secret' }),
    );
    expect(idA).toBe(idB);
  });

  it('Given two servers differing only in header values, Then identity is equal', () => {
    const idA = buildMcpServerIdentity('github', {
      type: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer first-secret' },
    });
    const idB = buildMcpServerIdentity('github', {
      type: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer rotated-secret' },
    });
    expect(idA).toBe(idB);
  });

  it('Given URL credentials or authentication args that rotate, Then identity remains stable', () => {
    const idA = buildMcpServerIdentity('remote', {
      type: 'http',
      url: 'https://user:first-password@example.com/mcp',
    });
    const idB = buildMcpServerIdentity('remote', {
      type: 'http',
      url: 'https://user:rotated-password@example.com/mcp',
    });
    const argsA = buildMcpServerIdentity('stdio', {
      type: 'stdio',
      command: 'srv',
      args: ['--token', 'first-token'],
    });
    const argsB = buildMcpServerIdentity('stdio', {
      type: 'stdio',
      command: 'srv',
      args: ['--token', 'rotated-token'],
    });
    expect(idA).toBe(idB);
    expect(argsA).toBe(argsB);
  });

  it('Given two servers with different transport, Then identity differs', () => {
    const idStdio = buildMcpServerIdentity('common', { type: 'stdio', command: 'srv' });
    const idHttp = buildMcpServerIdentity('common', { type: 'http', url: 'https://x' });
    expect(idStdio).not.toBe(idHttp);
  });

  it('Given the same stdio server name and transport but different command/args, Then identity differs', () => {
    const idA = buildMcpServerIdentity('common', {
      type: 'stdio',
      command: 'server-a',
      args: ['--mode', 'a'],
    });
    const idB = buildMcpServerIdentity('common', {
      type: 'stdio',
      command: 'server-b',
      args: ['--mode', 'b'],
    });
    expect(idA).not.toBe(idB);
  });

  it('Given the same remote server name and transport but different URL, Then identity differs', () => {
    const idA = buildMcpServerIdentity('remote', {
      type: 'http',
      url: 'https://one.example/mcp',
    });
    const idB = buildMcpServerIdentity('remote', {
      type: 'http',
      url: 'https://two.example/mcp',
    });
    expect(idA).not.toBe(idB);
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
