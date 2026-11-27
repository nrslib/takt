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
  it.each(['http', 'sse'] as const)('keeps defined provider references in %s headers without expanding their values', (type) => {
    const result = interpolateMcpEnv({
      type,
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer ${env:MCP_ACCESS}', 'X-Key': '${env:MCP_KEY}' },
    }, { MCP_ACCESS: 'synthetic-access', MCP_KEY: 'synthetic-key' });

    expect((result as McpHttpServerConfig | McpSseServerConfig).headers).toEqual({
      Authorization: 'Bearer ${env:MCP_ACCESS}',
      'X-Key': '${env:MCP_KEY}',
    });
  });

  it.each(['http', 'sse'] as const)('rejects an undefined provider reference in %s headers before startup', (type) => {
    expect(() => interpolateMcpEnv({
      type,
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer ${env:MCP_MISSING}' },
    }, {})).toThrow(/MCP_MISSING/);
  });

  it('accepts a defined empty provider variable without treating it as undefined', () => {
    const result = interpolateMcpEnv({
      type: 'http',
      url: 'https://example.com/mcp',
      headers: { 'X-Key': '${env:MCP_EMPTY}' },
    }, { MCP_EMPTY: '' });

    expect((result as McpHttpServerConfig).headers?.['X-Key']).toBe('${env:MCP_EMPTY}');
  });

  it('rejects inherited object properties that are not defined environment variables', () => {
    expect(() => interpolateMcpEnv({ type: 'http', url: 'https://example.com/mcp',
      headers: { 'X-Key': '${env:toString}' },
    }, {})).toThrow('toString');
  });

  it('distinguishes provider references from legacy references in the same header value', () => {
    const result = interpolateMcpEnv({
      type: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: '${MCP_SCHEME} ${env:MCP_ACCESS}', 'X-Tenant': '${MCP_TENANT}' },
    }, { MCP_SCHEME: 'Bearer', MCP_ACCESS: 'synthetic-access', MCP_TENANT: 'tenant-a' });

    expect((result as McpHttpServerConfig).headers).toEqual({
      Authorization: 'Bearer ${env:MCP_ACCESS}',
      'X-Tenant': 'tenant-a',
    });
  });

  it('keeps malformed provider reference strings literal', () => {
    const headers = { empty: '${env:}', digit: '${env:9X}', unclosed: '${env:X', nested: '${${env:X}}' };
    const result = interpolateMcpEnv({ type: 'http', url: 'https://example.com/mcp', headers }, {});

    expect((result as McpHttpServerConfig).headers).toEqual(headers);
  });

  it('does not interpret provider reference syntax in URL or stdio fields', () => {
    const remote = interpolateMcpEnv({ type: 'http', url: 'https://${env:MCP_HOST}/mcp' }, {});
    const stdio = interpolateMcpEnv({
      type: 'stdio', command: '${env:MCP_COMMAND}',
      args: ['${env:MCP_ARG}'], env: { VALUE: '${env:MCP_VALUE}' },
    }, {});

    expect((remote as McpHttpServerConfig).url).toBe('https://${env:MCP_HOST}/mcp');
    expect(stdio).toMatchObject({
      command: '${env:MCP_COMMAND}', args: ['${env:MCP_ARG}'], env: { VALUE: '${env:MCP_VALUE}' },
    });
  });

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
