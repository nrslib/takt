import { describe, expect, it } from 'vitest';
import { buildClaudeTerminalCommand } from '../infra/claude-terminal/command.js';

const SCHEMA = {
  type: 'object',
  properties: { decision: { type: 'string' } },
  required: ['decision'],
  additionalProperties: false,
};

describe('Claude terminal command builder', () => {
  it('Given interactive options, When building command, Then Claude Code is launched without headless flags', () => {
    const command = buildClaudeTerminalCommand({
      pathToClaudeCodeExecutable: '/opt/claude/bin/claude',
      model: 'opus',
      effort: 'high',
      allowedTools: ['Read', 'Edit'],
      mcpConfigPath: '/tmp/mcp-config.json',
      permissionMode: 'edit',
      bypassPermissions: false,
      sessionId: 'session-123',
      systemPrompt: 'You are a coder.',
      outputSchema: SCHEMA,
    });

    expect(command).toEqual({
      executable: '/opt/claude/bin/claude',
      args: [
        '--model',
        'opus',
        '--effort',
        'high',
        '--allowed-tools',
        'Read,Edit',
        '--mcp-config',
        '/tmp/mcp-config.json',
        '--permission-mode',
        'acceptEdits',
        '--resume',
        'session-123',
        '--system-prompt',
        'You are a coder.',
        '--json-schema',
        JSON.stringify(SCHEMA),
      ],
    });
    expect(command.args).not.toContain('-p');
    expect(command.args).not.toContain('--max-turns');
    expect(command.args).not.toContain('--output-format');
    expect(command.args).not.toContain('stream-json');
  });

  it('Given bypassPermissions true, When building command, Then bypassPermissions overrides permissionMode', () => {
    const command = buildClaudeTerminalCommand({
      pathToClaudeCodeExecutable: 'claude',
      permissionMode: 'readonly',
      bypassPermissions: true,
    });

    expect(command.args).toEqual(['--permission-mode', 'bypassPermissions']);
  });

  it('Given new session id, When building command without resume session, Then command pins the Claude transcript session id', () => {
    const command = buildClaudeTerminalCommand({
      pathToClaudeCodeExecutable: 'claude',
      newSessionId: 'generated-session-1',
    });

    expect(command.args).toEqual(['--session-id', 'generated-session-1']);
  });
});
