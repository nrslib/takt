import { describe, expect, it } from 'vitest';
import {
  PROVIDER_OPTIONS_ENV_SPECS,
  PROVIDER_OPTIONS_TRACE_PATHS,
  PROVIDER_OPTIONS_TRACKED_KEYS,
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
      'provider_options.opencode.allowed_tools',
      'provider_options.claude.effort',
      'provider_options.claude.sandbox.allow_unsandboxed_commands',
      'provider_options.claude.sandbox.excluded_commands',
      'provider_options.claude_terminal.backend',
      'provider_options.claude_terminal.timeout_ms',
      'provider_options.claude_terminal.keep_session',
      'provider_options.claude_terminal.transcript_poll_interval_ms',
      'provider_options.copilot.effort',
      'provider_options.kiro.agent',
    ]));
    expect(PROVIDER_OPTIONS_TRACE_PATHS).toContain('provider_options.claude.allowed_tools');
    expect(PROVIDER_OPTIONS_TRACE_PATHS).toContain('provider_options.codex.reasoning_effort');
    expect(PROVIDER_OPTIONS_TRACE_PATHS).toContain('provider_options.opencode.variant');
    expect(PROVIDER_OPTIONS_TRACE_PATHS).toContain('provider_options.opencode.allowed_tools');
    expect(PROVIDER_OPTIONS_TRACE_PATHS).toContain('provider_options.copilot.effort');
    expect(PROVIDER_OPTIONS_TRACE_PATHS).toContain('provider_options.claude_terminal.timeout_ms');
    expect(PROVIDER_OPTIONS_TRACE_PATHS).toContain('provider_options.kiro');
    expect(PROVIDER_OPTIONS_TRACE_PATHS).toContain('provider_options.kiro.agent');
  });

  it('tracked keys do not contain duplicate paths', () => {
    expect(PROVIDER_OPTIONS_TRACKED_KEYS).toHaveLength(new Set(PROVIDER_OPTIONS_TRACKED_KEYS).size);
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
    expect(toProviderOptionsTracePath('opencode.allowedTools'))
      .toBe('provider_options.opencode.allowed_tools');
    expect(toProviderOptionsTracePath('claudeTerminal.transcriptPollIntervalMs'))
      .toBe('provider_options.claude_terminal.transcript_poll_interval_ms');
    expect(toProviderOptionsTracePath('kiro.agent'))
      .toBe('provider_options.kiro.agent');
  });

  it('enumerates only present provider option leaves', () => {
    expect(getPresentProviderOptionPaths({
      codex: { networkAccess: true, reasoningEffort: 'high' },
      opencode: { variant: 'high', allowedTools: ['read', 'grep'] },
      claude: { effort: 'medium', sandbox: { excludedCommands: ['rm -rf'] } },
      claudeTerminal: { backend: 'tmux', keepSession: false },
      copilot: { effort: 'high' },
    })).toEqual([
      'codex.networkAccess',
      'codex.reasoningEffort',
      'opencode.variant',
      'opencode.allowedTools',
      'claude.effort',
      'claude.sandbox.excludedCommands',
      'claudeTerminal.backend',
      'claudeTerminal.keepSession',
      'copilot.effort',
    ]);
  });

  it('enumerates kiro.agent when present', () => {
    expect(getPresentProviderOptionPaths({
      kiro: { agent: 'planner-agent' },
    })).toEqual(['kiro.agent']);
  });

  it('does not enumerate kiro.agent for an empty kiro entry', () => {
    expect(getPresentProviderOptionPaths({
      kiro: {},
    })).toEqual([]);
  });
});
