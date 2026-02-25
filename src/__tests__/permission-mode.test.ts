/**
 * Tests for permission mode mapping functions
 */

import { describe, it, expect } from 'vitest';
import { SdkOptionsBuilder, buildSdkOptions } from '../infra/claude/options-builder.js';
import { mapToCodexSandboxMode } from '../infra/codex/types.js';
import type { PermissionMode } from '../core/models/index.js';
import type { ClaudeSpawnOptions } from '../infra/claude/types.js';

describe('SdkOptionsBuilder.mapToSdkPermissionMode', () => {
  it('should map readonly to SDK default', () => {
    expect(SdkOptionsBuilder.mapToSdkPermissionMode('readonly')).toBe('default');
  });

  it('should map edit to SDK acceptEdits', () => {
    expect(SdkOptionsBuilder.mapToSdkPermissionMode('edit')).toBe('acceptEdits');
  });

  it('should map full to SDK bypassPermissions', () => {
    expect(SdkOptionsBuilder.mapToSdkPermissionMode('full')).toBe('bypassPermissions');
  });

  it('should map all PermissionMode values exhaustively', () => {
    const modes: PermissionMode[] = ['readonly', 'edit', 'full'];
    for (const mode of modes) {
      const result = SdkOptionsBuilder.mapToSdkPermissionMode(mode);
      expect(result).toBeDefined();
      expect(typeof result).toBe('string');
    }
  });
});

describe('mapToCodexSandboxMode', () => {
  it('should map readonly to read-only', () => {
    expect(mapToCodexSandboxMode('readonly')).toBe('read-only');
  });

  it('should map edit to workspace-write', () => {
    expect(mapToCodexSandboxMode('edit')).toBe('workspace-write');
  });

  it('should map full to danger-full-access', () => {
    expect(mapToCodexSandboxMode('full')).toBe('danger-full-access');
  });

  it('should map all PermissionMode values exhaustively', () => {
    const modes: PermissionMode[] = ['readonly', 'edit', 'full'];
    for (const mode of modes) {
      const result = mapToCodexSandboxMode(mode);
      expect(result).toBeDefined();
      expect(typeof result).toBe('string');
    }
  });
});

describe('SdkOptionsBuilder.build() — mcpServers', () => {
  it('should include mcpServers in SDK options when provided', () => {
    const spawnOptions: ClaudeSpawnOptions = {
      cwd: '/tmp/test',
      mcpServers: {
        playwright: {
          command: 'npx',
          args: ['-y', '@anthropic-ai/mcp-server-playwright'],
        },
      },
    };

    const sdkOptions = buildSdkOptions(spawnOptions);
    expect(sdkOptions.mcpServers).toEqual({
      playwright: {
        command: 'npx',
        args: ['-y', '@anthropic-ai/mcp-server-playwright'],
      },
    });
  });

  it('should not include mcpServers in SDK options when not provided', () => {
    const spawnOptions: ClaudeSpawnOptions = {
      cwd: '/tmp/test',
    };

    const sdkOptions = buildSdkOptions(spawnOptions);
    expect(sdkOptions).not.toHaveProperty('mcpServers');
  });

  it('should include mcpServers alongside other options', () => {
    const spawnOptions: ClaudeSpawnOptions = {
      cwd: '/tmp/test',
      allowedTools: ['Read', 'mcp__playwright__*'],
      mcpServers: {
        playwright: {
          command: 'npx',
          args: ['-y', '@anthropic-ai/mcp-server-playwright'],
        },
      },
      permissionMode: 'edit',
    };

    const sdkOptions = buildSdkOptions(spawnOptions);
    expect(sdkOptions.mcpServers).toBeDefined();
    expect(sdkOptions.allowedTools).toEqual(['Read', 'mcp__playwright__*']);
    expect(sdkOptions.permissionMode).toBe('acceptEdits');
  });
});

describe('SdkOptionsBuilder.build() — settingSources', () => {
  it('includes project in settingSources', () => {
    const options = buildSdkOptions({ cwd: '/test' });
    expect(options.settingSources).toEqual(['project']);
  });
});
