/**
 * Tests for takt models
 */

import { describe, it, expect } from 'vitest';
import {
  AgentTypeSchema,
  StatusSchema,
  PermissionModeSchema,
  PieceConfigRawSchema,
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
          agent: 'coder',
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
    expect(result.max_iterations).toBe(10);
  });

  it('should parse movement with permission_mode', () => {
    const config = {
      name: 'test-piece',
      movements: [
        {
          name: 'implement',
          agent: 'coder',
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

  it('should allow omitting permission_mode', () => {
    const config = {
      name: 'test-piece',
      movements: [
        {
          name: 'plan',
          agent: 'planner',
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
          agent: 'coder',
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
  });

  it('should accept valid config', () => {
    const config = {
      default_piece: 'custom',
      log_level: 'debug' as const,
    };

    const result = GlobalConfigSchema.parse(config);
    expect(result.log_level).toBe('debug');
  });
});
