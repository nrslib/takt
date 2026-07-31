import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ConfiguredModelSchema } from '../../core/models/model-schema.js';
import { pickNestedObservabilityEnv } from '../../shared/telemetry/index.js';
import { buildIsolatedCodexSkillConfig } from './skill-config.js';
import { installStrictCodexAuthentication } from './strict-execution-auth.js';
import type { CodexCallOptions } from './types.js';

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

const STRICT_CODEX_DISABLED_FEATURES = [
  'apps',
  'auth_elicitation',
  'browser_use',
  'browser_use_external',
  'browser_use_full_cdp_access',
  'code_mode_host',
  'computer_use',
  'goals',
  'hooks',
  'image_generation',
  'in_app_browser',
  'multi_agent',
  'plugin_sharing',
  'plugins',
  'remote_plugin',
  'shell_tool',
  'skill_mcp_dependency_install',
  'tool_call_mcp_elicitation',
  'tool_suggest',
  'unified_exec',
] as const;

const STRICT_CODEX_DISABLED_SYSTEM_SKILLS = [
  'imagegen',
  'openai-docs',
  'plugin-creator',
  'skill-creator',
  'skill-installer',
] as const;

const RUNTIME_ENV_KEYS = [
  'COMSPEC',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'NODE_EXTRA_CA_CERTS',
  'NO_PROXY',
  'PATH',
  'PATHEXT',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'SystemRoot',
  'WINDIR',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'HTTP_PROXY',
  'HTTPS_PROXY',
] as const;

export interface StrictCodexExecutionProfile {
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  cleanup(): void;
}

interface ResolvedStrictCodexExecutionInput {
  readonly model: string | undefined;
  readonly outputSchema: Record<string, unknown>;
  readonly sourceSkillFiles: readonly string[];
}

function buildPrivateEnvironment(
  temporaryRoot: string,
  privateHome: string,
  codexHome: string,
  options: CodexCallOptions,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of RUNTIME_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  Object.assign(env, pickNestedObservabilityEnv(options.childProcessEnv));
  env.HOME = privateHome;
  env.USERPROFILE = privateHome;
  env.CODEX_HOME = codexHome;
  env.TMPDIR = temporaryRoot;
  env.TEMP = temporaryRoot;
  env.TMP = temporaryRoot;
  if (options.openaiApiKey !== undefined) {
    env.CODEX_API_KEY = options.openaiApiKey;
  }
  return env;
}

function resolveExplicitSkillFiles(options: CodexCallOptions): readonly string[] {
  const config = buildIsolatedCodexSkillConfig({
    cwd: options.cwd,
    env: process.env,
    inheritance: options.skills ?? { repo: false, user: false },
  });
  const skills = config?.skills as {
    config?: ReadonlyArray<{ path: string; enabled: boolean }>;
  } | undefined;
  const entries = skills?.config;
  return entries?.map((entry) => entry.path) ?? [];
}

function copySkillDirectory(source: string, destination: string): void {
  mkdirSync(destination, { mode: PRIVATE_DIRECTORY_MODE });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    const sourceStat = lstatSync(sourcePath);
    if (sourceStat.isSymbolicLink()) {
      throw new Error(`Strict read-only Codex Skill cannot contain a symbolic link: ${sourcePath}`);
    }
    if (sourceStat.isDirectory()) {
      copySkillDirectory(sourcePath, destinationPath);
      continue;
    }
    if (!sourceStat.isFile()) {
      throw new Error(`Strict read-only Codex Skill contains an unsupported entry: ${sourcePath}`);
    }
    copyFileSync(sourcePath, destinationPath);
    chmodSync(destinationPath, PRIVATE_FILE_MODE);
  }
}

function installExplicitSkills(
  codexHome: string,
  sourceSkillFiles: readonly string[],
): readonly string[] {
  if (sourceSkillFiles.length === 0) {
    return [];
  }
  const privateSkillsRoot = join(codexHome, 'skills');
  mkdirSync(privateSkillsRoot, { mode: PRIVATE_DIRECTORY_MODE });
  return sourceSkillFiles.map((sourceSkillFile, index) => {
    const destination = join(privateSkillsRoot, `explicit-${index + 1}`);
    copySkillDirectory(dirname(sourceSkillFile), destination);
    return join(destination, 'SKILL.md');
  });
}

function skillConfigArgument(
  codexHome: string,
  explicitSkillFiles: readonly string[],
): string {
  const entries = [
    ...STRICT_CODEX_DISABLED_SYSTEM_SKILLS.map((name) => ({
      path: join(codexHome, 'skills', '.system', name, 'SKILL.md'),
      enabled: false,
    })),
    ...explicitSkillFiles.map((path) => ({ path, enabled: true })),
  ];
  const value = entries
    .map((entry) => `{ path = ${JSON.stringify(entry.path)}, enabled = ${entry.enabled} }`)
    .join(', ');
  return `skills.config=[${value}]`;
}

function buildStrictArgs(
  workspacePath: string,
  schemaPath: string,
  codexHome: string,
  options: CodexCallOptions,
  model: string | undefined,
  explicitSkillFiles: readonly string[],
): string[] {
  const skills = skillConfigArgument(codexHome, explicitSkillFiles);
  return [
    'exec',
    '--json',
    '--strict-config',
    '--ignore-user-config',
    '--ignore-rules',
    '--ephemeral',
    '--skip-git-repo-check',
    '--sandbox',
    'read-only',
    '--config',
    'approval_policy="never"',
    '--config',
    'shell_environment_policy.inherit="none"',
    ...STRICT_CODEX_DISABLED_FEATURES.flatMap((feature) => ['--disable', feature]),
    '--cd',
    workspacePath,
    '--output-schema',
    schemaPath,
    ...(model === undefined ? [] : ['--model', model]),
    ...(options.reasoningEffort === undefined
      ? []
      : ['--config', `model_reasoning_effort="${options.reasoningEffort}"`]),
    ...(options.baseUrl === undefined
      ? []
      : ['--config', `openai_base_url=${JSON.stringify(options.baseUrl)}`]),
    ...(options.networkAccess === undefined
      ? []
      : ['--config', `sandbox_workspace_write.network_access=${options.networkAccess}`]),
    '--config',
    skills,
    ...(options.imageAttachments ?? []).flatMap((attachment) => ['--image', attachment.path]),
  ];
}

function resolveStrictCodexExecutionInput(
  options: CodexCallOptions,
): ResolvedStrictCodexExecutionInput {
  if (options.outputSchema === undefined) {
    throw new Error('Strict read-only Codex execution requires an output schema');
  }
  return {
    model: options.model === undefined
      ? undefined
      : ConfiguredModelSchema.parse(options.model),
    outputSchema: options.outputSchema,
    sourceSkillFiles: resolveExplicitSkillFiles(options),
  };
}

export function createStrictCodexExecutionProfile(
  options: CodexCallOptions,
): StrictCodexExecutionProfile {
  const input = resolveStrictCodexExecutionInput(options);
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'takt-codex-selector-'));
  try {
    chmodSync(temporaryRoot, PRIVATE_DIRECTORY_MODE);
    const privateHome = join(temporaryRoot, 'home');
    const codexHome = join(temporaryRoot, 'codex-home');
    const workspacePath = join(temporaryRoot, 'workspace');
    const schemaPath = join(temporaryRoot, 'schema.json');
    for (const path of [privateHome, codexHome, workspacePath]) {
      mkdirSync(path, { mode: PRIVATE_DIRECTORY_MODE });
    }
    installStrictCodexAuthentication(codexHome, options.openaiApiKey);
    const explicitSkillFiles = installExplicitSkills(
      codexHome,
      input.sourceSkillFiles,
    );
    writeFileSync(schemaPath, JSON.stringify(input.outputSchema), {
      encoding: 'utf-8',
      flag: 'wx',
      mode: PRIVATE_FILE_MODE,
    });
    return {
      args: buildStrictArgs(
        workspacePath,
        schemaPath,
        codexHome,
        options,
        input.model,
        explicitSkillFiles,
      ),
      env: buildPrivateEnvironment(temporaryRoot, privateHome, codexHome, options),
      cleanup(): void {
        rmSync(temporaryRoot, { recursive: true, force: true });
      },
    };
  } catch (error) {
    rmSync(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}
