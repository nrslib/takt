import { describe, expect, it } from 'vitest';
import {
  PROVIDER_OPTIONS_ENV_SPECS,
  PROVIDER_OPTIONS_TRACE_PATHS,
  getPresentProviderOptionPaths,
  toProviderOptionsTracePath,
} from '../infra/config/providerOptionsContract.js';

describe('providerOptionsContract', () => {
  it('provider_options contract paths stay aligned across env and trace definitions', () => {
    const envPaths = new Set(PROVIDER_OPTIONS_ENV_SPECS.map((spec) => spec.path));

    expect(envPaths).toEqual(new Set([
      'provider_options',
      'provider_options.codex.network_access',
      'provider_options.codex.reasoning_effort',
      'provider_options.opencode.network_access',
      'provider_options.opencode.variant',
      'provider_options.cursor.use_prompt_temp_file',
      'provider_options.kiro.use_prompt_temp_file',
      'provider_options.claude.effort',
      'provider_options.claude.use_prompt_temp_file',
      'provider_options.claude.sandbox.allow_unsandboxed_commands',
      'provider_options.claude.sandbox.excluded_commands',
      'provider_options.claude_terminal.backend',
      'provider_options.claude_terminal.timeout_ms',
      'provider_options.claude_terminal.keep_session',
      'provider_options.claude_terminal.transcript_poll_interval_ms',
      'provider_options.copilot.effort',
      'provider_options.copilot.use_prompt_temp_file',
    ]));
    expect(PROVIDER_OPTIONS_TRACE_PATHS).toContain('provider_options.claude.allowed_tools');
    expect(PROVIDER_OPTIONS_TRACE_PATHS).toContain('provider_options.codex.reasoning_effort');
    expect(PROVIDER_OPTIONS_TRACE_PATHS).toContain('provider_options.opencode.variant');
    expect(PROVIDER_OPTIONS_TRACE_PATHS).toContain('provider_options.cursor.use_prompt_temp_file');
    expect(PROVIDER_OPTIONS_TRACE_PATHS).toContain('provider_options.kiro.use_prompt_temp_file');
    expect(PROVIDER_OPTIONS_TRACE_PATHS).toContain('provider_options.claude.use_prompt_temp_file');
    expect(PROVIDER_OPTIONS_TRACE_PATHS).toContain('provider_options.copilot.effort');
    expect(PROVIDER_OPTIONS_TRACE_PATHS).toContain('provider_options.copilot.use_prompt_temp_file');
    expect(PROVIDER_OPTIONS_TRACE_PATHS).toContain('provider_options.claude_terminal.timeout_ms');
  });

  it('maps internal provider option paths to traced-config paths', () => {
    expect(toProviderOptionsTracePath('claude.sandbox.allowUnsandboxedCommands'))
      .toBe('provider_options.claude.sandbox.allow_unsandboxed_commands');
    expect(toProviderOptionsTracePath('claude.allowedTools'))
      .toBe('provider_options.claude.allowed_tools');
    expect(toProviderOptionsTracePath('codex.reasoningEffort'))
      .toBe('provider_options.codex.reasoning_effort');
    expect(toProviderOptionsTracePath('opencode.variant'))
      .toBe('provider_options.opencode.variant');
    expect(toProviderOptionsTracePath('cursor.usePromptTempFile'))
      .toBe('provider_options.cursor.use_prompt_temp_file');
    expect(toProviderOptionsTracePath('kiro.usePromptTempFile'))
      .toBe('provider_options.kiro.use_prompt_temp_file');
    expect(toProviderOptionsTracePath('claude.usePromptTempFile'))
      .toBe('provider_options.claude.use_prompt_temp_file');
    expect(toProviderOptionsTracePath('copilot.usePromptTempFile'))
      .toBe('provider_options.copilot.use_prompt_temp_file');
    expect(toProviderOptionsTracePath('claudeTerminal.transcriptPollIntervalMs'))
      .toBe('provider_options.claude_terminal.transcript_poll_interval_ms');
  });

  it('enumerates only present provider option leaves', () => {
    expect(getPresentProviderOptionPaths({
      codex: { networkAccess: true, reasoningEffort: 'high' },
      opencode: { variant: 'high' },
      cursor: { usePromptTempFile: true },
      kiro: { usePromptTempFile: true },
      claude: { effort: 'medium', usePromptTempFile: true, sandbox: { excludedCommands: ['rm -rf'] } },
      claudeTerminal: { backend: 'tmux', keepSession: false },
      copilot: { effort: 'high', usePromptTempFile: true },
    } as Parameters<typeof getPresentProviderOptionPaths>[0])).toEqual([
      'codex.networkAccess',
      'codex.reasoningEffort',
      'opencode.variant',
      'cursor.usePromptTempFile',
      'kiro.usePromptTempFile',
      'claude.effort',
      'claude.usePromptTempFile',
      'claude.sandbox.excludedCommands',
      'claudeTerminal.backend',
      'claudeTerminal.keepSession',
      'copilot.effort',
      'copilot.usePromptTempFile',
    ]);
  });
});
