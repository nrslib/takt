import type { GlobalConfig } from '../../core/models/config-types.js';
import type { RemoteCredentialsConfig } from '../../core/models/daemon-config-schema.js';
import { envVarNameFromPath } from '../../infra/config/env/config-env-overrides.js';

const providers = {
  anthropic: ['ANTHROPIC_API_KEY', 'anthropicApiKey', 'anthropic_api_key'],
  openai: ['OPENAI_API_KEY', 'openaiApiKey', 'openai_api_key'],
  gemini: ['GEMINI_API_KEY', 'geminiApiKey', 'gemini_api_key'],
  google: ['GOOGLE_API_KEY', 'googleApiKey', 'google_api_key'],
  groq: ['GROQ_API_KEY', 'groqApiKey', 'groq_api_key'],
  openrouter: ['OPENROUTER_API_KEY', 'openrouterApiKey', 'openrouter_api_key'],
  copilot: ['COPILOT_GITHUB_TOKEN', 'copilotGithubToken', 'copilot_github_token'],
  kiro: ['KIRO_API_KEY', 'kiroApiKey', 'kiro_api_key'],
  opencode: ['OPENCODE_API_KEY', 'opencodeApiKey', 'opencode_api_key'],
  cursor: ['CURSOR_API_KEY', 'cursorApiKey', 'cursor_api_key'],
} as const;

/** Resolve only the explicitly configured references; task text never enters this function. */
export function resolveRemoteCredentials(config: RemoteCredentialsConfig | undefined, environment: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  const resolve = (reference: string): string => {
    const name = reference.slice(2, -1);
    const value = environment[name];
    if (!value || Buffer.byteLength(value, 'utf8') > 8192) throw new Error(`Remote credential environment variable is missing or too large: ${name}`);
    return value;
  };
  if (config?.git !== undefined) result.TAKT_REMOTE_GIT_TOKEN = resolve(config.git);
  if (config?.gh !== undefined) result.GH_TOKEN = result.GITHUB_TOKEN = resolve(config.gh);
  for (const [provider, mapping] of Object.entries(providers)) {
    const reference = config?.providers?.[provider as keyof typeof providers];
    if (reference !== undefined) {
      const value = resolve(reference);
      result[mapping[0]] = value;
      result[envVarNameFromPath(mapping[2])] = value;
    }
  }
  return result;
}

export function remoteCredentialConfigOverrides(environment: NodeJS.ProcessEnv): Partial<GlobalConfig> {
  const result: Record<string, string> = {};
  const names = new Set<string>(JSON.parse(environment.TAKT_REMOTE_CREDENTIAL_NAMES ?? '[]') as string[]);
  for (const [variable, key] of Object.values(providers)) {
    if (names.has(variable) && environment[variable] !== undefined) result[key] = environment[variable];
  }
  return result;
}
