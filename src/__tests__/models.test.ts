/**
 * Tests for takt models
 */

import { describe, it, expect } from 'vitest';
import {
  AgentTypeSchema,
  StatusSchema,
  PermissionModeSchema,
  PieceConfigRawSchema,
  McpServerConfigSchema,
  CustomAgentConfigSchema,
  GlobalConfigSchema,
} from '../core/models/index.js';

describe('AgentTypeSchema', () => {
  it('should accept valid agent types', () => {
    expect(AgentTypeSchema.parse('coder')).toBe('coder');
    expect(AgentTypeSchema.parse('architect')).toBe('architect');
    expect(AgentTypeSchema.parse('supervisor')).toBe('supervisor');
    expect(AgentTypeSchema.parse('custom')).toBe('custom');
  });

  it('should reject invalid agent types', () => {
    expect(() => AgentTypeSchema.parse('invalid')).toThrow();
  });
});

describe('StatusSchema', () => {
  it('should accept valid statuses', () => {
    expect(StatusSchema.parse('pending')).toBe('pending');
    expect(StatusSchema.parse('done')).toBe('done');
    expect(StatusSchema.parse('approved')).toBe('approved');
    expect(StatusSchema.parse('rejected')).toBe('rejected');
    expect(StatusSchema.parse('blocked')).toBe('blocked');
    expect(StatusSchema.parse('error')).toBe('error');
    expect(StatusSchema.parse('answer')).toBe('answer');
  });

  it('should reject invalid statuses', () => {
    expect(() => StatusSchema.parse('unknown')).toThrow();
    expect(() => StatusSchema.parse('conditional')).toThrow();
  });
});

describe('PermissionModeSchema', () => {
  it('should accept valid permission modes', () => {
    expect(PermissionModeSchema.parse('readonly')).toBe('readonly');
    expect(PermissionModeSchema.parse('edit')).toBe('edit');
    expect(PermissionModeSchema.parse('full')).toBe('full');
  });

  it('should reject invalid permission modes', () => {
    expect(() => PermissionModeSchema.parse('readOnly')).toThrow();
    expect(() => PermissionModeSchema.parse('admin')).toThrow();
    expect(() => PermissionModeSchema.parse('default')).toThrow();
    expect(() => PermissionModeSchema.parse('acceptEdits')).toThrow();
    expect(() => PermissionModeSchema.parse('bypassPermissions')).toThrow();
  });
});

describe('PieceConfigRawSchema', () => {
  it('should parse valid piece config', () => {
    const config = {
      name: 'test-piece',
      description: 'A test piece',
      movements: [
        {
          name: 'step1',
          persona: 'coder',
          allowed_tools: ['Read', 'Grep'],
          instruction: '{task}',
          rules: [
            { condition: 'Task completed', next: 'COMPLETE' },
          ],
        },
      ],
    };

    const result = PieceConfigRawSchema.parse(config);
    expect(result.name).toBe('test-piece');
    expect(result.movements).toHaveLength(1);
    expect(result.movements![0]?.allowed_tools).toEqual(['Read', 'Grep']);
    expect(result.max_movements).toBe(10);
  });

  it('should parse movement with permission_mode', () => {
    const config = {
      name: 'test-piece',
      movements: [
        {
          name: 'implement',
          persona: 'coder',
          allowed_tools: ['Read', 'Edit', 'Write', 'Bash'],
          permission_mode: 'edit',
          instruction: '{task}',
          rules: [
            { condition: 'Done', next: 'COMPLETE' },
          ],
        },
      ],
    };

    const result = PieceConfigRawSchema.parse(config);
    expect(result.movements![0]?.permission_mode).toBe('edit');
  });

  it('should parse movement with provider_options', () => {
    const config = {
      name: 'test-piece',
      movements: [
        {
          name: 'implement',
          provider: 'codex',
          provider_options: {
            codex: { network_access: true },
            opencode: { network_access: false },
          },
          instruction: '{task}',
        },
      ],
    };

    const result = PieceConfigRawSchema.parse(config);
    expect(result.movements![0]?.provider_options).toEqual({
      codex: { network_access: true },
      opencode: { network_access: false },
    });
  });

  it('should parse piece-level piece_config.provider_options', () => {
    const config = {
      name: 'test-piece',
      piece_config: {
        provider_options: {
          codex: { network_access: true },
        },
      },
      movements: [
        {
          name: 'implement',
          provider: 'codex',
          instruction: '{task}',
        },
      ],
    };

    const result = PieceConfigRawSchema.parse(config);
    expect(result.piece_config).toEqual({
      provider_options: {
        codex: { network_access: true },
      },
    });
  });

  it('should allow omitting permission_mode', () => {
    const config = {
      name: 'test-piece',
      movements: [
        {
          name: 'plan',
          persona: 'planner',
          instruction: '{task}',
        },
      ],
    };

    const result = PieceConfigRawSchema.parse(config);
    expect(result.movements![0]?.permission_mode).toBeUndefined();
  });

  it('should reject invalid permission_mode', () => {
    const config = {
      name: 'test-piece',
      movements: [
        {
          name: 'step1',
          persona: 'coder',
          permission_mode: 'superAdmin',
          instruction: '{task}',
        },
      ],
    };

    expect(() => PieceConfigRawSchema.parse(config)).toThrow();
  });

  it('should require at least one movement', () => {
    const config = {
      name: 'empty-piece',
      movements: [],
    };

    expect(() => PieceConfigRawSchema.parse(config)).toThrow();
  });

  it('should parse movement with stdio mcp_servers', () => {
    const config = {
      name: 'test-piece',
      movements: [
        {
          name: 'e2e-test',
          persona: 'coder',
          mcp_servers: {
            playwright: {
              command: 'npx',
              args: ['-y', '@anthropic-ai/mcp-server-playwright'],
            },
          },
          allowed_tools: ['mcp__playwright__*'],
          instruction: '{task}',
        },
      ],
    };

    const result = PieceConfigRawSchema.parse(config);
    expect(result.movements![0]?.mcp_servers).toEqual({
      playwright: {
        command: 'npx',
        args: ['-y', '@anthropic-ai/mcp-server-playwright'],
      },
    });
  });

  it('should parse movement with sse mcp_servers', () => {
    const config = {
      name: 'test-piece',
      movements: [
        {
          name: 'step1',
          persona: 'coder',
          mcp_servers: {
            remote: {
              type: 'sse',
              url: 'http://localhost:8080/sse',
              headers: { Authorization: 'Bearer token' },
            },
          },
          instruction: '{task}',
        },
      ],
    };

    const result = PieceConfigRawSchema.parse(config);
    expect(result.movements![0]?.mcp_servers).toEqual({
      remote: {
        type: 'sse',
        url: 'http://localhost:8080/sse',
        headers: { Authorization: 'Bearer token' },
      },
    });
  });

  it('should parse movement with http mcp_servers', () => {
    const config = {
      name: 'test-piece',
      movements: [
        {
          name: 'step1',
          persona: 'coder',
          mcp_servers: {
            api: {
              type: 'http',
              url: 'http://localhost:3000/mcp',
            },
          },
          instruction: '{task}',
        },
      ],
    };

    const result = PieceConfigRawSchema.parse(config);
    expect(result.movements![0]?.mcp_servers).toEqual({
      api: {
        type: 'http',
        url: 'http://localhost:3000/mcp',
      },
    });
  });

  it('should allow omitting mcp_servers', () => {
    const config = {
      name: 'test-piece',
      movements: [
        {
          name: 'step1',
          persona: 'coder',
          instruction: '{task}',
        },
      ],
    };

    const result = PieceConfigRawSchema.parse(config);
    expect(result.movements![0]?.mcp_servers).toBeUndefined();
  });

  it('should reject invalid mcp_servers (missing command for stdio)', () => {
    const config = {
      name: 'test-piece',
      movements: [
        {
          name: 'step1',
          persona: 'coder',
          mcp_servers: {
            broken: { args: ['--flag'] },
          },
          instruction: '{task}',
        },
      ],
    };

    expect(() => PieceConfigRawSchema.parse(config)).toThrow();
  });

  it('should reject invalid mcp_servers (missing url for sse)', () => {
    const config = {
      name: 'test-piece',
      movements: [
        {
          name: 'step1',
          persona: 'coder',
          mcp_servers: {
            broken: { type: 'sse' },
          },
          instruction: '{task}',
        },
      ],
    };

    expect(() => PieceConfigRawSchema.parse(config)).toThrow();
  });
});

describe('McpServerConfigSchema', () => {
  it('should parse stdio config', () => {
    const config = { command: 'npx', args: ['-y', 'some-server'], env: { NODE_ENV: 'test' } };
    const result = McpServerConfigSchema.parse(config);
    expect(result).toEqual(config);
  });

  it('should parse stdio config with command only', () => {
    const config = { command: 'mcp-server' };
    const result = McpServerConfigSchema.parse(config);
    expect(result).toEqual(config);
  });

  it('should parse stdio config with explicit type', () => {
    const config = { type: 'stdio' as const, command: 'npx', args: ['-y', 'some-server'] };
    const result = McpServerConfigSchema.parse(config);
    expect(result).toEqual(config);
  });

  it('should parse sse config', () => {
    const config = { type: 'sse' as const, url: 'http://localhost:8080/sse' };
    const result = McpServerConfigSchema.parse(config);
    expect(result).toEqual(config);
  });

  it('should parse sse config with headers', () => {
    const config = { type: 'sse' as const, url: 'http://example.com', headers: { 'X-Key': 'val' } };
    const result = McpServerConfigSchema.parse(config);
    expect(result).toEqual(config);
  });

  it('should parse http config', () => {
    const config = { type: 'http' as const, url: 'http://localhost:3000/mcp' };
    const result = McpServerConfigSchema.parse(config);
    expect(result).toEqual(config);
  });

  it('should parse http config with headers', () => {
    const config = { type: 'http' as const, url: 'http://example.com', headers: { Authorization: 'Bearer x' } };
    const result = McpServerConfigSchema.parse(config);
    expect(result).toEqual(config);
  });

  it('should reject empty command for stdio', () => {
    expect(() => McpServerConfigSchema.parse({ command: '' })).toThrow();
  });

  it('should reject missing url for sse', () => {
    expect(() => McpServerConfigSchema.parse({ type: 'sse' })).toThrow();
  });

  it('should reject missing url for http', () => {
    expect(() => McpServerConfigSchema.parse({ type: 'http' })).toThrow();
  });

  it('should reject empty url for sse', () => {
    expect(() => McpServerConfigSchema.parse({ type: 'sse', url: '' })).toThrow();
  });

  it('should reject unknown type', () => {
    expect(() => McpServerConfigSchema.parse({ type: 'websocket', url: 'ws://localhost' })).toThrow();
  });

  it('should reject empty object', () => {
    expect(() => McpServerConfigSchema.parse({})).toThrow();
  });
});

describe('CustomAgentConfigSchema', () => {
  it('should accept agent with prompt', () => {
    const config = {
      name: 'my-agent',
      prompt: 'You are a helpful assistant.',
    };

    const result = CustomAgentConfigSchema.parse(config);
    expect(result.name).toBe('my-agent');
  });

  it('should accept agent with prompt_file', () => {
    const config = {
      name: 'my-agent',
      prompt_file: '/path/to/prompt.md',
    };

    const result = CustomAgentConfigSchema.parse(config);
    expect(result.prompt_file).toBe('/path/to/prompt.md');
  });

  it('should accept agent with claude_agent', () => {
    const config = {
      name: 'my-agent',
      claude_agent: 'architect',
    };

    const result = CustomAgentConfigSchema.parse(config);
    expect(result.claude_agent).toBe('architect');
  });

  it('should accept agent with provider override', () => {
    const config = {
      name: 'my-agent',
      prompt: 'You are a helpful assistant.',
      provider: 'codex',
    };

    const result = CustomAgentConfigSchema.parse(config);
    expect(result.provider).toBe('codex');
  });

  it('should reject agent without any prompt source', () => {
    const config = {
      name: 'my-agent',
    };

    expect(() => CustomAgentConfigSchema.parse(config)).toThrow();
  });
});

describe('GlobalConfigSchema', () => {
  it('should provide defaults', () => {
    const config = {};
    const result = GlobalConfigSchema.parse(config);

    expect(result.default_piece).toBe('default');
    expect(result.log_level).toBe('info');
    expect(result.provider).toBe('claude');
    expect(result.observability).toBeUndefined();
  });

  it('should accept valid config', () => {
    const config = {
      default_piece: 'custom',
      log_level: 'debug' as const,
      observability: {
        provider_events: false,
      },
    };

    const result = GlobalConfigSchema.parse(config);
    expect(result.log_level).toBe('debug');
    expect(result.observability?.provider_events).toBe(false);
  });
});
