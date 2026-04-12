/**
 * Tests for takt models
 */

import { describe, it, expect } from 'vitest';
import {
  AgentTypeSchema,
  StatusSchema,
  PermissionModeSchema,
  WorkflowConfigRawSchema as WorkflowConfigRawSchema,
  WorkflowStepRawSchema as WorkflowStepRawSchema,
  McpServerConfigSchema,
  CustomAgentConfigSchema,
  GlobalConfigSchema,
  ProjectConfigSchema,
} from '../core/models/index.js';
import { STATUS_VALUES } from '../core/models/status.js';
import type { WorkflowTemplateReference } from '../core/models/index.js';

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
    expect(StatusSchema.parse('done')).toBe('done');
    expect(StatusSchema.parse('blocked')).toBe('blocked');
    expect(StatusSchema.parse('error')).toBe('error');
  });

  it('should align with the shared status contract values', () => {
    expect(StatusSchema.options).toEqual([...STATUS_VALUES]);
  });

  it('should reject invalid statuses', () => {
    expect(() => StatusSchema.parse('unknown')).toThrow();
    expect(() => StatusSchema.parse('conditional')).toThrow();
    expect(() => StatusSchema.parse('pending')).toThrow();
    expect(() => StatusSchema.parse('approved')).toThrow();
    expect(() => StatusSchema.parse('rejected')).toThrow();
    expect(() => StatusSchema.parse('improve')).toThrow();
    expect(() => StatusSchema.parse('cancelled')).toThrow();
    expect(() => StatusSchema.parse('interrupted')).toThrow();
    expect(() => StatusSchema.parse('answer')).toThrow();
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

describe('WorkflowConfigRawSchema', () => {
  it('should allow nested workflow template references at the public type level', () => {
    const structuredReference: WorkflowTemplateReference = '{structured:plan.payload.action}';
    const effectReference: WorkflowTemplateReference = '{effect:comment_on_pr.comment_pr.result.id}';

    expect(structuredReference).toBe('{structured:plan.payload.action}');
    expect(effectReference).toBe('{effect:comment_on_pr.comment_pr.result.id}');
  });

  it('should parse valid workflow config', () => {
    const config = {
      name: 'test-workflow',
      description: 'A test workflow',
      steps: [
        {
          name: 'step1',
          persona: 'coder',
          provider_options: {
            claude: {
              allowed_tools: ['Read', 'Grep'],
            },
          },
          instruction: '{task}',
          rules: [
            { condition: 'Task completed', next: 'COMPLETE' },
          ],
        },
      ],
    };

    const result = WorkflowConfigRawSchema.parse(config);
    expect(result.name).toBe('test-workflow');
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.provider_options).toEqual({
      claude: {
        allowed_tools: ['Read', 'Grep'],
      },
    });
    expect(result.max_steps).toBe(10);
  });

  it('should parse step with required_permission_mode', () => {
    const config = {
      name: 'test-workflow',
      steps: [
        {
          name: 'implement',
          persona: 'coder',
          provider_options: {
            claude: {
              allowed_tools: ['Read', 'Edit', 'Write', 'Bash'],
            },
          },
          required_permission_mode: 'edit',
          instruction: '{task}',
          rules: [
            { condition: 'Done', next: 'COMPLETE' },
          ],
        },
      ],
    };

    const result = WorkflowConfigRawSchema.parse(config);
    expect(result.steps[0]?.required_permission_mode).toBe('edit');
  });

  it('should parse step with provider_options', () => {
    const config = {
      name: 'test-workflow',
      steps: [
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

    const result = WorkflowConfigRawSchema.parse(config);
    expect(result.steps[0]?.provider_options).toEqual({
      codex: { network_access: true },
      opencode: { network_access: false },
    });
  });

  it('should parse step with provider object block', () => {
    const config = {
      name: 'test-workflow',
      steps: [
        {
          name: 'implement',
          provider: {
            type: 'codex',
            model: 'gpt-5.3',
            network_access: true,
          },
          instruction: '{task}',
        },
      ],
    };

    const result = WorkflowConfigRawSchema.parse(config as unknown);
    const step = result.steps?.[0] as Record<string, unknown> | undefined;
    const provider = step?.provider as Record<string, unknown> | undefined;
    expect(provider?.type).toBe('codex');
    expect(provider?.model).toBe('gpt-5.3');
    expect(provider?.network_access).toBe(true);
  });

  it('should reject provider block when claude sets network_access', () => {
    const config = {
      name: 'test-workflow',
      steps: [
        {
          name: 'implement',
          provider: {
            type: 'claude',
            network_access: true,
          },
          instruction: '{task}',
        },
      ],
    };

    expect(() => WorkflowConfigRawSchema.parse(config as unknown)).toThrow(/network_access/);
  });

  it('should reject provider block when codex sets sandbox', () => {
    const config = {
      name: 'test-workflow',
      steps: [
        {
          name: 'implement',
          provider: {
            type: 'codex',
            sandbox: {
              allow_unsandboxed_commands: true,
            },
          },
          instruction: '{task}',
        },
      ],
    };

    expect(() => WorkflowConfigRawSchema.parse(config as unknown)).toThrow(/sandbox/);
  });

  it('should reject provider block with unknown fields', () => {
    const config = {
      name: 'test-workflow',
      steps: [
        {
          name: 'implement',
          provider: {
            type: 'codex',
            model: 'gpt-5.3',
            network_access: true,
            unknown_option: true,
          },
          instruction: '{task}',
        },
      ],
    };

    expect(() => WorkflowConfigRawSchema.parse(config as unknown)).toThrow();
  });

  it('should parse workflow-level workflow_config.provider block', () => {
    const config = {
      name: 'test-workflow',
      workflow_config: {
        provider: {
          type: 'codex',
          model: 'gpt-5.3',
          network_access: true,
        },
      },
      steps: [
        {
          name: 'implement',
          instruction: '{task}',
        },
      ],
    };

    const result = WorkflowConfigRawSchema.parse(config as unknown);
    const workflowConfig = result.workflow_config as Record<string, unknown> | undefined;
    const provider = workflowConfig?.provider as Record<string, unknown> | undefined;
    expect(provider?.type).toBe('codex');
    expect(provider?.model).toBe('gpt-5.3');
    expect(provider?.network_access).toBe(true);
  });

  it('should parse workflow-level workflow_config.provider_options', () => {
    const config = {
      name: 'test-workflow',
      workflow_config: {
        provider_options: {
          codex: { network_access: true },
        },
      },
      steps: [
        {
          name: 'implement',
          provider: 'codex',
          instruction: '{task}',
        },
      ],
    };

    const result = WorkflowConfigRawSchema.parse(config);
    expect(result.workflow_config).toEqual({
      provider_options: {
        codex: { network_access: true },
      },
    });
  });

  it('should parse workflow-level workflow_config.runtime.prepare', () => {
    const config = {
      name: 'test-workflow',
      workflow_config: {
        runtime: {
          prepare: ['gradle', 'node'],
        },
      },
      steps: [
        {
          name: 'implement',
          instruction: '{task}',
        },
      ],
    };

    const result = WorkflowConfigRawSchema.parse(config);
    expect(result.workflow_config).toEqual({
      runtime: {
        prepare: ['gradle', 'node'],
      },
    });
  });

  it('should parse workflow-level workflow_config', () => {
    const config = {
      name: 'test-workflow',
      workflow_config: {
        provider_options: {
          codex: { network_access: true },
        },
      },
      steps: [
        {
          name: 'implement',
          provider: 'codex',
          instruction: '{task}',
        },
      ],
    };

    const result = WorkflowConfigRawSchema.parse(config);
    expect(result.workflow_config).toEqual({
      provider_options: {
        codex: { network_access: true },
      },
    });
  });

  it('should reject a removed workflow config alias when workflow_config is present', () => {
    const config = {
      name: 'test-workflow',
      workflow_config: {
        provider_options: {
          codex: { network_access: true },
        },
      },
      piece_config: {
        provider_options: {
          codex: { network_access: false },
        },
      },
      steps: [
        {
          name: 'implement',
          provider: 'codex',
          instruction: '{task}',
        },
      ],
    };

    expect(() => WorkflowConfigRawSchema.parse(config)).toThrow(/piece_config|workflow_config|unrecognized/i);
  });

  it('should reject a removed step-list key', () => {
    const config = {
      name: 'legacy-step-list',
      movements: [
        {
          name: 'plan',
          persona: 'coder',
          instruction: '{task}',
        },
      ],
    };

    expect(() => WorkflowConfigRawSchema.parse(config as unknown)).toThrow(/movements|steps|unrecognized/i);
  });

  it('should reject removed step boundary keys', () => {
    const config = {
      name: 'legacy-step-keys',
      initial_movement: 'plan',
      max_movements: 3,
      steps: [
        {
          name: 'plan',
          persona: 'coder',
          instruction: '{task}',
        },
      ],
    };

    expect(() => WorkflowConfigRawSchema.parse(config as unknown)).toThrow(
      /initial_movement|max_movements|initial_step|max_steps|unrecognized/i,
    );
  });

  it('should parse workflow-facing project config aliases', () => {
    const project = ProjectConfigSchema.parse({
      workflow_overrides: {
        steps: {
          implement: {
            quality_gates: ['gate'],
          },
        },
      },
      workflow_runtime_prepare: {
        custom_scripts: true,
      },
      workflow_arpeggio: {
        custom_data_source_modules: true,
        custom_merge_inline_js: false,
        custom_merge_files: true,
      },
      workflow_mcp_servers: {
        stdio: true,
        sse: false,
        http: true,
      },
    } as unknown) as Record<string, unknown>;

    expect(project.workflow_overrides).toEqual({
      steps: {
        implement: {
          quality_gates: ['gate'],
        },
      },
    });
    expect(project.workflow_runtime_prepare).toEqual({ custom_scripts: true });
    expect(project.workflow_arpeggio).toEqual({
      custom_data_source_modules: true,
      custom_merge_inline_js: false,
      custom_merge_files: true,
    });
    expect(project.workflow_mcp_servers).toEqual({ stdio: true, sse: false, http: true });
  });

  it('should parse workflow-facing global config aliases', () => {
    const global = GlobalConfigSchema.parse({
      workflow_categories_file: '/tmp/workflow-categories.yaml',
      enable_builtin_workflows: true,
      notification_sound_events: {
        workflow_complete: true,
        workflow_abort: false,
      },
    } as unknown) as Record<string, unknown>;

    expect(global.workflow_categories_file).toBe('/tmp/workflow-categories.yaml');
    expect(global.enable_builtin_workflows).toBe(true);
    expect(global.notification_sound_events).toEqual({
      workflow_complete: true,
      workflow_abort: false,
    });
  });

  it('should allow omitting required_permission_mode', () => {
    const config = {
      name: 'test-workflow',
      steps: [
        {
          name: 'plan',
          persona: 'planner',
          instruction: '{task}',
        },
      ],
    };

    const result = WorkflowConfigRawSchema.parse(config);
    expect(result.steps[0]?.required_permission_mode).toBeUndefined();
  });

  it('should reject invalid required_permission_mode', () => {
    const config = {
      name: 'test-workflow',
      steps: [
        {
          name: 'step1',
          persona: 'coder',
          required_permission_mode: 'superAdmin',
          instruction: '{task}',
        },
      ],
    };

    expect(() => WorkflowConfigRawSchema.parse(config)).toThrow();
  });

  it('should require at least one step', () => {
    const config = {
      name: 'empty-workflow',
      steps: [],
    };

    expect(() => WorkflowConfigRawSchema.parse(config)).toThrow();
  });

  it('should parse step with stdio mcp_servers', () => {
    const config = {
      name: 'test-workflow',
      steps: [
        {
          name: 'e2e-test',
          persona: 'coder',
          mcp_servers: {
            playwright: {
              command: 'npx',
              args: ['-y', '@anthropic-ai/mcp-server-playwright'],
            },
          },
          provider_options: {
            claude: {
              allowed_tools: ['mcp__playwright__*'],
            },
          },
          instruction: '{task}',
        },
      ],
    };

    const result = WorkflowConfigRawSchema.parse(config);
    expect(result.steps[0]?.mcp_servers).toEqual({
      playwright: {
        command: 'npx',
        args: ['-y', '@anthropic-ai/mcp-server-playwright'],
      },
    });
  });

  it('should parse step with sse mcp_servers', () => {
    const config = {
      name: 'test-workflow',
      steps: [
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

    const result = WorkflowConfigRawSchema.parse(config);
    expect(result.steps[0]?.mcp_servers).toEqual({
      remote: {
        type: 'sse',
        url: 'http://localhost:8080/sse',
        headers: { Authorization: 'Bearer token' },
      },
    });
  });

  it('should parse step with http mcp_servers', () => {
    const config = {
      name: 'test-workflow',
      steps: [
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

    const result = WorkflowConfigRawSchema.parse(config);
    expect(result.steps[0]?.mcp_servers).toEqual({
      api: {
        type: 'http',
        url: 'http://localhost:3000/mcp',
      },
    });
  });

  it('should parse removed-key MCP config blocks', () => {
    const project = ProjectConfigSchema.parse({
      workflow_mcp_servers: {
        stdio: true,
        sse: false,
        http: true,
      },
    } as unknown) as Record<string, unknown>;

    const global = GlobalConfigSchema.parse({
      workflow_mcp_servers: {
        http: true,
      },
    } as unknown) as Record<string, unknown>;

    expect(project.workflow_mcp_servers).toEqual({ stdio: true, sse: false, http: true });
    expect(global.workflow_mcp_servers).toEqual({ http: true });
  });

  it('should allow omitting mcp_servers', () => {
    const config = {
      name: 'test-workflow',
      steps: [
        {
          name: 'step1',
          persona: 'coder',
          instruction: '{task}',
        },
      ],
    };

    const result = WorkflowConfigRawSchema.parse(config);
    expect(result.steps[0]?.mcp_servers).toBeUndefined();
  });

  it('should reject invalid mcp_servers (missing command for stdio)', () => {
    const config = {
      name: 'test-workflow',
      steps: [
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

    expect(() => WorkflowConfigRawSchema.parse(config)).toThrow();
  });

  it('should reject invalid mcp_servers (missing url for sse)', () => {
    const config = {
      name: 'test-workflow',
      steps: [
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

    expect(() => WorkflowConfigRawSchema.parse(config)).toThrow();
  });

  it('should reject step-level allowed_tools', () => {
    const step = {
      name: 'step1',
      persona: 'coder',
      allowed_tools: ['Read'],
      instruction: '{task}',
    };

    const result = WorkflowStepRawSchema.safeParse(step);
    expect(result.success).toBe(false);
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

  it('should reject agent without any prompt source', () => {
    const config = {
      name: 'my-agent',
    };

    expect(() => CustomAgentConfigSchema.parse(config)).toThrow();
  });

  it('should reject legacy claude keys even when prompt is present', () => {
    const config = {
      name: 'my-agent',
      prompt: 'You are a helpful assistant.',
      claude_agent: 'legacy-agent',
    };

    expect(() => CustomAgentConfigSchema.parse(config)).toThrow(/unrecognized key/i);
  });
});

describe('GlobalConfigSchema', () => {
  it('should provide defaults', () => {
    const config = {};
    const result = GlobalConfigSchema.parse(config);

    expect(result.provider).toBe('claude');
    expect(result.logging).toBeUndefined();
  });

  it('should accept valid logging config', () => {
    const config = {
      logging: {
        provider_events: false,
        usage_events: true,
      },
    };

    const result = GlobalConfigSchema.parse(config);
    expect(result.logging?.provider_events).toBe(false);
    expect(result.logging?.usage_events).toBe(true);
  });

  it('should accept full logging config with all fields', () => {
    const config = {
      logging: {
        level: 'debug',
        trace: true,
        debug: true,
        provider_events: true,
        usage_events: false,
      },
    };

    const result = GlobalConfigSchema.parse(config);
    expect(result.logging?.level).toBe('debug');
    expect(result.logging?.trace).toBe(true);
    expect(result.logging?.debug).toBe(true);
    expect(result.logging?.provider_events).toBe(true);
    expect(result.logging?.usage_events).toBe(false);
  });

  it('should accept partial logging config', () => {
    const config = {
      logging: {
        level: 'warn',
      },
    };

    const result = GlobalConfigSchema.parse(config);
    expect(result.logging?.level).toBe('warn');
    expect(result.logging?.trace).toBeUndefined();
    expect(result.logging?.debug).toBeUndefined();
    expect(result.logging?.provider_events).toBeUndefined();
    expect(result.logging?.usage_events).toBeUndefined();
  });

  it('should reject invalid logging level', () => {
    const config = {
      logging: {
        level: 'verbose',
      },
    };

    expect(() => GlobalConfigSchema.parse(config)).toThrow();
  });

  it('should reject observability key (strict schema rejects unknown keys)', () => {
    const config = {
      observability: {
        provider_events: false,
      },
    };

    expect(() => GlobalConfigSchema.parse(config)).toThrow();
  });

  it('should parse global provider object block', () => {
    const result = GlobalConfigSchema.parse({
      provider: {
        type: 'codex',
        model: 'gpt-5.3',
        network_access: true,
      },
    } as unknown);
    const provider = (result as Record<string, unknown>).provider as Record<string, unknown> | undefined;
    expect(provider?.type).toBe('codex');
    expect(provider?.model).toBe('gpt-5.3');
    expect(provider?.network_access).toBe(true);
  });

  it('should parse takt_providers.assistant in global config schema', () => {
    const result = GlobalConfigSchema.parse({
      provider: 'codex',
      model: 'gpt-5.4',
      takt_providers: {
        assistant: {
          provider: 'claude',
          model: 'haiku',
        },
      },
    } as unknown) as Record<string, unknown>;

    expect(result.takt_providers).toEqual({
      assistant: {
        provider: 'claude',
        model: 'haiku',
      },
    });
  });

  it('should reject persona_providers because it is project-local only', () => {
    expect(() => GlobalConfigSchema.parse({
      persona_providers: {
        coder: {
          type: 'codex',
          network_access: true,
        },
      },
    } as unknown)).toThrow();
  });
});

describe('ProjectConfigSchema', () => {
  it('should parse project provider object block', () => {
    const result = ProjectConfigSchema.parse({
      provider: {
        type: 'codex',
        model: 'gpt-5.3',
        network_access: false,
      },
    } as unknown);
    const provider = (result as Record<string, unknown>).provider as Record<string, unknown> | undefined;
    expect(provider?.type).toBe('codex');
    expect(provider?.model).toBe('gpt-5.3');
    expect(provider?.network_access).toBe(false);
  });


  it('should parse workflow_runtime_prepare policy block', () => {
    const result = ProjectConfigSchema.parse({
      workflow_runtime_prepare: {
        custom_scripts: true,
      },
    } as unknown) as Record<string, unknown>;

    expect(result.workflow_runtime_prepare).toEqual({
      custom_scripts: true,
    });
  });

  it('should parse workflow_arpeggio policy block', () => {
    const result = ProjectConfigSchema.parse({
      workflow_arpeggio: {
        custom_data_source_modules: true,
        custom_merge_inline_js: false,
        custom_merge_files: true,
      },
    } as unknown) as Record<string, unknown>;

    expect(result.workflow_arpeggio).toEqual({
      custom_data_source_modules: true,
      custom_merge_inline_js: false,
      custom_merge_files: true,
    });
  });

  it('should parse takt_providers.assistant in project config schema', () => {
    const result = ProjectConfigSchema.parse({
      provider: 'codex',
      model: 'gpt-5.4',
      takt_providers: {
        assistant: {
          provider: 'claude',
          model: 'haiku',
        },
      },
    } as unknown) as Record<string, unknown>;

    expect(result.takt_providers).toEqual({
      assistant: {
        provider: 'claude',
        model: 'haiku',
      },
    });
  });

  it('should parse sync_conflict_resolver config block', () => {
    const result = ProjectConfigSchema.parse({
      sync_conflict_resolver: {
        auto_approve_tools: true,
      },
    } as unknown) as Record<string, unknown>;

    expect(result.sync_conflict_resolver).toEqual({
      auto_approve_tools: true,
    });
  });
});
