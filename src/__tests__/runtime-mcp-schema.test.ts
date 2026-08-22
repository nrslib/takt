import { describe, expect, it } from 'vitest';
// New module under test (implemented in the following `implement` step).
// Import errors here are expected until then.
import { RuntimeProviderFileSchema } from '../infra/config/runtime-provider/schema.js';

/**
 * Contracts covered (see plan.md 完了契約):
 * - `MCP-SCHEMA` (要件1,2,3,101,103,104)
 *   - `mcp` セクションは `provider` と並ぶトップレベル sibling として parse される
 *   - `mcp` セクションは `provider` なしで単独 active 判定可能な shape を保持する
 *   - `mcp.servers` で stdio/sse/http server を定義できる
 *   - `mcp.defaults.servers` で string 配列を受け付ける
 *   - `mcp.targets` は personas/tags/steps/internal_agents の 4 種のみ許可する
 *   - `internal_agents` target は `selector` キー配下の `exclude` のみを持つ
 *   - `mcp` セクションを `provider.targets` 配下に置くことは不可
 *
 * 反例:
 *   - `mcp` を `provider.targets` 配下に置く → reject
 *   - `mcp` active に `provider` active を必須にする → この schema では検査しないが、
 *     `mcp` 単独で parse 成功することで `hasActiveMcpSection` 側で分離できる
 *   - 未知の target selector（`models` など）→ reject
 *   - `internal_agents.selector.exclude` 以外の `internal_agents` フィールド → reject
 */

type LooseMcpDoc = {
  version?: unknown;
  mcp?: {
    servers?: Record<string, unknown>;
    defaults?: { servers?: unknown };
    targets?: {
      personas?: Record<string, unknown>;
      tags?: Record<string, unknown>;
      steps?: Record<string, unknown>;
      internal_agents?: Record<string, unknown>;
      models?: unknown;
    };
  };
};

function fullMcpExample(): LooseMcpDoc {
  return {
    version: 1,
    mcp: {
      servers: {
        'common-tools': { type: 'stdio', command: 'common-mcp-server', args: [], env: { API_TOKEN: '${COMMON_MCP_API_TOKEN}' } },
        github: { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer ${GITHUB_TOKEN}' } },
      },
      defaults: { servers: ['common-tools'] },
      targets: {
        personas: { 'release-manager': { servers: ['github'] } },
        tags: { github: { servers: ['github'] } },
        steps: { 'release/create-pr': { servers: ['github'] } },
        internal_agents: { selector: { exclude: ['common-tools'] } },
      },
    },
  };
}

describe('RuntimeProviderFileSchema — mcp section (MCP-SCHEMA)', () => {
  it('Given the full order.md mcp example, When parsed, Then it is accepted', () => {
    const result = RuntimeProviderFileSchema.safeParse(fullMcpExample());
    expect(result.success).toBe(true);
  });

  it('Given mcp without provider, When parsed, Then it is accepted (mcp independent from provider, 要件2)', () => {
    const result = RuntimeProviderFileSchema.safeParse({
      version: 1,
      mcp: {
        servers: { tools: { command: 'srv' } },
        defaults: { servers: ['tools'] },
      },
    });
    expect(result.success).toBe(true);
  });

  it('Given a stdio server, When parsed, Then it is accepted (要件3)', () => {
    const result = RuntimeProviderFileSchema.safeParse({
      version: 1,
      mcp: {
        servers: { s: { type: 'stdio', command: 'srv', args: ['-x'], env: { K: 'v' } } },
      },
    });
    expect(result.success).toBe(true);
  });

  it('Given an sse server, When parsed, Then it is accepted (要件3)', () => {
    const result = RuntimeProviderFileSchema.safeParse({
      version: 1,
      mcp: {
        servers: { s: { type: 'sse', url: 'http://localhost:8080/sse', headers: { 'X-Key': 'v' } } },
      },
    });
    expect(result.success).toBe(true);
  });

  it('Given an http server, When parsed, Then it is accepted (要件3)', () => {
    const result = RuntimeProviderFileSchema.safeParse({
      version: 1,
      mcp: {
        servers: { s: { type: 'http', url: 'http://localhost:3000/mcp' } },
      },
    });
    expect(result.success).toBe(true);
  });

  it('Given a stdio server without explicit type, When parsed, Then it defaults to stdio (要件3)', () => {
    const result = RuntimeProviderFileSchema.safeParse({
      version: 1,
      mcp: { servers: { s: { command: 'srv' } } },
    });
    expect(result.success).toBe(true);
  });

  it('Given mcp.defaults.servers as string array, When parsed, Then it is accepted (要件4)', () => {
    const result = RuntimeProviderFileSchema.safeParse({
      version: 1,
      mcp: { servers: { a: { command: 'x' } }, defaults: { servers: ['a'] } },
    });
    expect(result.success).toBe(true);
  });

  it('Given targets.personas with servers array, When parsed, Then it is accepted (要件5)', () => {
    const result = RuntimeProviderFileSchema.safeParse({
      version: 1,
      mcp: {
        servers: { a: { command: 'x' } },
        targets: { personas: { rm: { servers: ['a'] } } },
      },
    });
    expect(result.success).toBe(true);
  });

  it('Given targets.personas with exclude array, When parsed, Then it is accepted (要件5)', () => {
    const result = RuntimeProviderFileSchema.safeParse({
      version: 1,
      mcp: {
        servers: { a: { command: 'x' } },
        targets: { personas: { rm: { exclude: ['a'] } } },
      },
    });
    expect(result.success).toBe(true);
  });

  it('Given targets.tags with servers+exclude, When parsed, Then it is accepted (要件6)', () => {
    const result = RuntimeProviderFileSchema.safeParse({
      version: 1,
      mcp: {
        servers: { a: { command: 'x' }, b: { command: 'y' } },
        targets: { tags: { github: { servers: ['a'], exclude: ['b'] } } },
      },
    });
    expect(result.success).toBe(true);
  });

  it('Given targets.steps with fully-qualified-name key, When parsed, Then it is accepted (要件7)', () => {
    const result = RuntimeProviderFileSchema.safeParse({
      version: 1,
      mcp: {
        servers: { a: { command: 'x' } },
        targets: { steps: { 'release/create-pr': { servers: ['a'] } } },
      },
    });
    expect(result.success).toBe(true);
  });

  it('Given targets.internal_agents.selector.exclude, When parsed, Then it is accepted (要件8,104)', () => {
    const result = RuntimeProviderFileSchema.safeParse({
      version: 1,
      mcp: {
        servers: { a: { command: 'x' } },
        targets: { internal_agents: { selector: { exclude: ['a'] } } },
      },
    });
    expect(result.success).toBe(true);
  });

  it('Given mcp.targets with an unknown selector, When parsed, Then it is rejected (要件103)', () => {
    const doc = fullMcpExample();
    (doc.mcp!.targets as { models?: unknown }).models = { foo: { servers: ['x'] } };
    const result = RuntimeProviderFileSchema.safeParse(doc);
    expect(result.success).toBe(false);
  });

  it('Given internal_agents with servers (instead of selector.exclude), When parsed, Then it is rejected (要件104)', () => {
    const doc = fullMcpExample();
    (doc.mcp!.targets!.internal_agents as { servers?: unknown }) = { servers: ['x'] };
    const result = RuntimeProviderFileSchema.safeParse(doc);
    expect(result.success).toBe(false);
  });

  it('Given internal_agents with exclude at top level (not under selector), When parsed, Then it is rejected (要件104)', () => {
    const doc = fullMcpExample();
    (doc.mcp!.targets!.internal_agents as { exclude?: unknown }) = { exclude: ['x'] };
    const result = RuntimeProviderFileSchema.safeParse(doc);
    expect(result.success).toBe(false);
  });

  it('Given mcp under provider.targets, When parsed, Then it is rejected (要件2: mcp is top-level sibling)', () => {
    const result = RuntimeProviderFileSchema.safeParse({
      version: 1,
      provider: { targets: { mcp: { servers: { a: { command: 'x' } } } } },
    });
    expect(result.success).toBe(false);
  });

  it('Given an unknown transport type, When parsed, Then it is rejected (要件3)', () => {
    const result = RuntimeProviderFileSchema.safeParse({
      version: 1,
      mcp: { servers: { s: { type: 'websocket', url: 'ws://x' } } },
    });
    expect(result.success).toBe(false);
  });

  it('Given an empty stdio command, When parsed, Then it is rejected (要件3)', () => {
    const result = RuntimeProviderFileSchema.safeParse({
      version: 1,
      mcp: { servers: { s: { type: 'stdio', command: '' } } },
    });
    expect(result.success).toBe(false);
  });

  it('Given an sse server missing url, When parsed, Then it is rejected (要件3)', () => {
    const result = RuntimeProviderFileSchema.safeParse({
      version: 1,
      mcp: { servers: { s: { type: 'sse' } } },
    });
    expect(result.success).toBe(false);
  });

  it('Given an http server with empty url, When parsed, Then it is rejected (要件3)', () => {
    const result = RuntimeProviderFileSchema.safeParse({
      version: 1,
      mcp: { servers: { s: { type: 'http', url: '' } } },
    });
    expect(result.success).toBe(false);
  });

  it('Given a server entry with an unknown transport-specific key, When parsed, Then it is rejected', () => {
    const result = RuntimeProviderFileSchema.safeParse({
      version: 1,
      mcp: {
        servers: {
          stdio: { command: 'srv', unexpected: true },
          remote: { type: 'http', url: 'http://localhost/mcp', unexpected: true },
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('Given mcp as a non-object, When parsed, Then it is rejected', () => {
    expect(RuntimeProviderFileSchema.safeParse({ version: 1, mcp: [] }).success).toBe(false);
    expect(RuntimeProviderFileSchema.safeParse({ version: 1, mcp: null }).success).toBe(false);
  });

  it('Given mcp.defaults as a non-object, When parsed, Then it is rejected', () => {
    const result = RuntimeProviderFileSchema.safeParse({
      version: 1,
      mcp: { defaults: 'invalid' },
    });
    expect(result.success).toBe(false);
  });

  it('Given mcp.defaults.servers as a non-array, When parsed, Then it is rejected (要件4)', () => {
    const result = RuntimeProviderFileSchema.safeParse({
      version: 1,
      mcp: { defaults: { servers: 'invalid' } },
    });
    expect(result.success).toBe(false);
  });

  it('Given mcp.servers as a non-record, When parsed, Then it is rejected', () => {
    const result = RuntimeProviderFileSchema.safeParse({
      version: 1,
      mcp: { servers: 'invalid' },
    });
    expect(result.success).toBe(false);
  });

  it('Given an mcp-only file (no provider, no version), When parsed, Then it is rejected (version required)', () => {
    const result = RuntimeProviderFileSchema.safeParse({ mcp: { servers: { a: { command: 'x' } } } });
    expect(result.success).toBe(false);
  });

  it('Given mcp with extra unknown top-level key inside mcp, When parsed, Then strict rejects it', () => {
    const doc = fullMcpExample();
    (doc.mcp as { unknown_extra?: unknown }).unknown_extra = 'x';
    const result = RuntimeProviderFileSchema.safeParse(doc);
    expect(result.success).toBe(false);
  });
});
