export const MANAGED_PROVIDERS = ['claude-sdk', 'codex', 'opencode', 'pi', 'deepseek-harness'] as const;
export type ManagedProvider = typeof MANAGED_PROVIDERS[number];

// Four estimates come from the task specification; DeepSeek uses the macOS arm64 installed disk usage.
export const MANAGED_PROVIDER_SIZE_MB = { 'claude-sdk': 250, codex: 340, opencode: 60, pi: 52, 'deepseek-harness': 510 } as const;

export function managedProviderFor(provider: string): ManagedProvider | undefined {
  if (provider === 'claude') return 'claude-sdk';
  return MANAGED_PROVIDERS.find((name) => name === provider);
}

export const MANAGED_MODULES = {
  'claude-sdk': [{ name: '@anthropic-ai/claude-agent-sdk', export: '.', required: ['query', 'AbortError'] }],
  codex: [{ name: '@openai/codex-sdk', export: '.', required: ['Codex'] }],
  opencode: [
    { name: '@opencode-ai/sdk', export: './v2', required: ['createOpencodeClient'] },
    { name: '@opencode/client', export: '.', required: ['OpenCode'] },
  ],
  pi: [
    { name: '@earendil-works/pi-coding-agent', export: '.', required: ['createAgentSession', 'SessionManager', 'ModelRuntime'] },
    { name: '@earendil-works/pi-ai', export: '.', required: ['InMemoryCredentialStore', 'InMemoryModelsStore'] },
  ],
} as const;
