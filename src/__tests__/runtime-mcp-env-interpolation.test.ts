import { describe, expect, it } from 'vitest';
// New module under test (implemented in the following `implement` step).
import {
  interpolateMcpEnv,
} from '../infra/config/runtime-provider/mcp-schema.js';
import type {
  McpHttpServerConfig,
  McpSseServerConfig,
  McpStdioServerConfig,
} from '../core/models/workflow-provider-options.js';

/**
 * Contracts covered (see plan.md 完了契約):
 * - `MCP-ENV` (要件15,16)
 *   - `${NAME}` 環境変数参照を agent 起動前に解決する
 *   - 未定義の必須環境変数は fail-fast する
 *   - env は `Record<string,string>` として解決済み値を返す（stdio env へそのまま渡せる）
 *
 * 反例:
 *   - 未定義 env を空文字で黙埋めする → fail-fast しない
 *   - ヘッダー内の ${...} を未解決のまま残す → fail-fast しない
 */

describe('interpolateMcpEnv (MCP-ENV)', () => {
  it('Given a stdio server with ${VAR} in env, When interpolated, Then the value is resolved from the explicit env source', () => {
    const result = interpolateMcpEnv({
      type: 'stdio',
      command: 'srv',
      env: { API_TOKEN: '${MCP_TEST_TOKEN}' },
    }, { MCP_TEST_TOKEN: 'secret-value' });
    expect((result as McpStdioServerConfig).env?.API_TOKEN).toBe('secret-value');
  });

  it('Given a stdio server with literal env value, When interpolated, Then it is kept as-is', () => {
    const result = interpolateMcpEnv({
      type: 'stdio',
      command: 'srv',
      env: { STATIC: 'literal-value' },
    }, {});
    expect((result as McpStdioServerConfig).env?.STATIC).toBe('literal-value');
  });

  it('Given a stdio server with an undefined required env var, When interpolated, Then it fails fast (要件16)', () => {
    expect(() =>
      interpolateMcpEnv({
        type: 'stdio',
        command: 'srv',
        env: { API_TOKEN: '${MCP_UNDEFINED_TOKEN}' },
      }, {}),
    ).toThrow(/MCP_UNDEFINED_TOKEN/);
  });

  it('Given an http server with ${VAR} in headers, When interpolated, Then the value is resolved', () => {
    const result = interpolateMcpEnv({
      type: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer ${MCP_AUTH_TOKEN}' },
    }, { MCP_AUTH_TOKEN: 'bearer-value' });
    expect((result as McpHttpServerConfig).headers?.Authorization).toBe('Bearer bearer-value');
  });

  it('Given an http server with an undefined header env var, When interpolated, Then it fails fast (要件16)', () => {
    expect(() =>
      interpolateMcpEnv({
        type: 'http',
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer ${MCP_UNDEFINED_HEADER}' },
      }, {}),
    ).toThrow(/MCP_UNDEFINED_HEADER/);
  });

  it('Given an sse server with ${VAR} in url, When interpolated, Then the value is resolved', () => {
    const result = interpolateMcpEnv({
      type: 'sse',
      url: 'http://${MCP_HOST}:8080/sse',
    }, { MCP_HOST: 'mcp.local' });
    expect((result as McpSseServerConfig).url).toBe('http://mcp.local:8080/sse');
  });

  it('Given a stdio server with ${VAR} in args, When interpolated, Then the value is resolved', () => {
    const result = interpolateMcpEnv({
      type: 'stdio',
      command: 'srv',
      args: ['--env', '${MCP_FLAG}'],
    }, { MCP_FLAG: 'production' });
    expect((result as McpStdioServerConfig).args).toEqual(['--env', 'production']);
  });

  it('Given a server with multiple env vars in one value, When interpolated, Then both are resolved', () => {
    const result = interpolateMcpEnv({
      type: 'stdio',
      command: 'srv',
      env: { COMBINED: '${MCP_A}-${MCP_B}' },
    }, { MCP_A: 'alpha', MCP_B: 'beta' });
    expect((result as McpStdioServerConfig).env?.COMBINED).toBe('alpha-beta');
  });

  it('Given a server with no env references, When interpolated, Then it is returned unchanged', () => {
    const result = interpolateMcpEnv({
      type: 'stdio',
      command: 'srv',
      args: ['--literal'],
    }, {});
    expect(result).toEqual({ type: 'stdio', command: 'srv', args: ['--literal'] });
  });

  it('Given an env var with the same name as a shell builtin, When interpolated, Then it still resolves from the explicit env source', () => {
    const result = interpolateMcpEnv({
      type: 'stdio',
      command: '${PATH}',
    }, { PATH: '/usr/local/bin:/usr/bin' });
    expect((result as McpStdioServerConfig).command).toBe('/usr/local/bin:/usr/bin');
  });

  it('Given an undefined lowercase env var reference, When interpolated, Then it fails fast', () => {
    expect(() => interpolateMcpEnv({
      type: 'stdio',
      command: '${lowercase_token}',
    }, {})).toThrow(/lowercase_token/);
  });
});
