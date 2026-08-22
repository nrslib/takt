import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import * as path from 'node:path';
import {
  createBashToolDefinition,
  createAgentSession,
  DefaultPackageManager,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type CreateAgentSessionOptions,
  type ExtensionError,
  type LoadExtensionsResult,
  type ResolvedPaths,
} from '@earendil-works/pi-coding-agent';
import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type Api,
  type Credential,
  type ImageContent,
  type Model,
} from '@earendil-works/pi-ai';
import type { AgentResponse } from '../../core/models/index.js';
import { buildEnvWithNestedObservabilitySnapshot } from '../../shared/telemetry/index.js';
import {
  classifyAbortSignalReason,
  createProviderErrorFailure,
  formatAgentFailure,
} from '../../shared/types/agent-failure.js';
import type { StreamCallback } from '../../shared/types/provider.js';
import { createLogger, getErrorMessage } from '../../shared/utils/index.js';
import { safeExternalErrorMessage } from '../../shared/utils/safeExternalErrorMessage.js';
import { sanitizeSensitiveText } from '../../shared/utils/sensitiveText.js';
import type { ProviderImageAttachment } from '../providers/types.js';
import { validateProviderImageAttachments } from '../providers/imageAttachments.js';
import type { PiCallOptions } from './types.js';
import { resolvePiActiveTools } from '../providers/pi-tool-policy.js';

const PI_THINKING_LEVEL_VALUES = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
type PiThinkingLevel = (typeof PI_THINKING_LEVEL_VALUES)[number];
const PI_THINKING_LEVELS = new Set<string>(PI_THINKING_LEVEL_VALUES);

function isPiThinkingLevel(value: string): value is PiThinkingLevel {
  return PI_THINKING_LEVELS.has(value);
}

function isAbortRequested(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

interface PiSessionRecord {
  session: AgentSession;
  runtime: ModelRuntime;
  cwd: string;
  configurationFingerprint: string;
  extensionErrors: string[];
  operationTail: Promise<void>;
  activeOperations: number;
  lastUsedAt: number;
  retired: boolean;
  disposed: boolean;
  disposalPromise?: Promise<void>;
}

interface PiSessionCreation {
  promise: Promise<PiSessionRecord>;
  abortController: AbortController;
  waiters: number;
  settled: boolean;
  record?: PiSessionRecord;
  handoffLeaseHeld: boolean;
}

const sessions = new Map<string, PiSessionRecord>();
const sessionCreations = new Map<string, PiSessionCreation>();
const MAX_CACHED_PI_SESSIONS = 64;
const ABORT_CLEANUP_TIMEOUT_MS = 30_000;
const log = createLogger('pi');

async function awaitAbortCleanup(cleanup: Promise<void>): Promise<void> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      cleanup,
      new Promise<void>((resolve) => {
        timeoutId = setTimeout(() => {
          log.debug('Pi session abort cleanup timed out', {
            timeoutMs: ABORT_CLEANUP_TIMEOUT_MS,
          });
          resolve();
        }, ABORT_CLEANUP_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

function isCredential(value: unknown): value is Credential {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const type = (value as Record<string, unknown>).type;
  return type === 'api_key' || type === 'oauth';
}

async function loadPiCredentials(authPath: string): Promise<InMemoryCredentialStore> {
  const credentials = new InMemoryCredentialStore();
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(authPath, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return credentials;
    }
    throw new Error(`Failed to read Pi credentials from ${authPath}`, { cause: error });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Pi credentials at ${authPath} must be a JSON object`);
  }
  for (const [providerId, credential] of Object.entries(parsed)) {
    if (!isCredential(credential)) {
      throw new Error(`Pi credential for provider "${providerId}" is invalid`);
    }
    await credentials.modify(providerId, async () => structuredClone(credential));
  }
  return credentials;
}

async function createModelRuntime(agentDir: string): Promise<ModelRuntime> {
  return ModelRuntime.create({
    credentials: await loadPiCredentials(path.join(agentDir, 'auth.json')),
    // Read the user's provider/model declarations, but keep refreshed catalogs
    // in memory so a TAKT call never writes Pi's models-store.json.
    modelsPath: path.join(agentDir, 'models.json'),
    modelsStore: new InMemoryModelsStore(),
    // Resolve the SDK's default model from the local credential store/env without
    // fetching remote catalogs. Keep refreshed credentials and catalogs process-local.
    allowModelNetwork: false,
    refreshOnCreate: true,
  });
}

function splitModelReference(modelReference: string): {
  provider?: string;
  modelId: string;
  thinkingLevel?: PiThinkingLevel;
} {
  const trimmed = modelReference.trim();
  const colonIndex = trimmed.lastIndexOf(':');
  const suffix = colonIndex >= 0 ? trimmed.slice(colonIndex + 1) : '';
  const modelWithThinking = colonIndex >= 0 && isPiThinkingLevel(suffix)
    ? trimmed.slice(0, colonIndex)
    : trimmed;
  const slashIndex = modelWithThinking.indexOf('/');

  return {
    provider: slashIndex > 0 ? modelWithThinking.slice(0, slashIndex) : undefined,
    modelId: slashIndex > 0 ? modelWithThinking.slice(slashIndex + 1) : modelWithThinking,
    ...(suffix && isPiThinkingLevel(suffix) ? { thinkingLevel: suffix } : {}),
  };
}

function resolvePiModel(
  modelReference: string | undefined,
  runtime: ModelRuntime,
): { model?: Model<Api>; thinkingLevel?: PiThinkingLevel } {
  if (!modelReference?.trim()) {
    return {};
  }

  const parsed = splitModelReference(modelReference);
  if (parsed.provider) {
    const model = runtime.getModel(parsed.provider, parsed.modelId);
    if (model) {
      return { model, thinkingLevel: parsed.thinkingLevel };
    }
    throw new Error(
      `Pi model "${modelReference}" was not found. Use provider/model format or configure the model in Pi.`,
    );
  }

  const matches = runtime.getModels().filter((model) => model.id === parsed.modelId);
  if (matches.length === 1) {
    return { model: matches[0], thinkingLevel: parsed.thinkingLevel };
  }

  throw new Error(
    `Pi model "${modelReference}" was not found. Use provider/model format or configure the model in Pi.`,
  );
}

function assertSafeExtensionSources(sources: readonly string[]): void {
  for (const source of sources) {
    const trimmedSource = source.trim();
    if (trimmedSource.startsWith('npm:') && !getSafeNpmPackageName(trimmedSource)) {
      throw new Error('Pi npm extension sources must use a valid package name');
    }
    const candidate = trimmedSource.startsWith('git:') && !trimmedSource.startsWith('git://')
      ? trimmedSource.slice('git:'.length)
      : trimmedSource;
    const authority = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#\s]*)/u.exec(candidate)?.[1];
    if (authority?.includes('@')) {
      throw new Error(
        'Pi extension URLs must not embed credentials; use SSH or a Git credential helper',
      );
    }
    try {
      const url = new URL(candidate);
      if (url.username || url.password) {
        throw new Error(
          'Pi extension URLs must not embed credentials; use SSH or a Git credential helper',
        );
      }
      for (const key of url.searchParams.keys()) {
        if (/api[_-]?key|token|password|secret|credential/iu.test(key)) {
          throw new Error(
            'Pi extension URLs must not embed credentials; use SSH or a Git credential helper',
          );
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Pi extension URLs')) {
        throw error;
      }
      // Local paths, npm package specs, and SCP-style Git sources are not URLs.
    }
  }
}

function applyPiTools(session: AgentSession, options: PiCallOptions): void {
  const allTools = session.getAllTools().map((tool) => ({
    name: tool.name,
    source: tool.sourceInfo.source,
  }));
  session.setActiveToolsByName(resolvePiActiveTools(
    options.permissionMode,
    options.allowedTools,
    allTools,
  ));
}

function enabledResourcePaths(paths: ResolvedPaths, key: keyof ResolvedPaths): string[] {
  return paths[key]
    .filter((resource) => resource.enabled)
    .map((resource) => resource.path);
}

function countEnabledResolvedResources(paths: ResolvedPaths): number {
  return enabledResourcePaths(paths, 'extensions').length
    + enabledResourcePaths(paths, 'skills').length
    + enabledResourcePaths(paths, 'prompts').length
    + enabledResourcePaths(paths, 'themes').length;
}

function mergeResolvedPaths(base: ResolvedPaths, additions: ResolvedPaths): ResolvedPaths {
  return {
    extensions: [...base.extensions, ...additions.extensions],
    skills: [...base.skills, ...additions.skills],
    prompts: [...base.prompts, ...additions.prompts],
    themes: [...base.themes, ...additions.themes],
  };
}

function isNpmExtensionSource(source: string): boolean {
  return source.trim().startsWith('npm:');
}

function getSafeNpmPackageName(source: string): string | undefined {
  const spec = source.trim().slice('npm:'.length);
  const versionDelimiter = spec.startsWith('@')
    ? spec.indexOf('@', spec.indexOf('/') + 1)
    : spec.indexOf('@');
  const packageName = versionDelimiter >= 0 ? spec.slice(0, versionDelimiter) : spec;
  const unscopedName = /^[a-z0-9][a-z0-9._~-]*$/u;
  const scopedName = /^@[a-z0-9][a-z0-9._~-]*\/[a-z0-9._~-]+$/u;
  if (scopedName.test(packageName)) {
    const member = packageName.slice(packageName.indexOf('/') + 1);
    if (member === '.' || member === '..') {
      return undefined;
    }
  }
  return unscopedName.test(packageName) || scopedName.test(packageName)
    ? packageName
    : undefined;
}

function isVersionQualifiedNpmExtensionSource(source: string): boolean {
  const spec = source.trim().slice('npm:'.length);
  return spec.startsWith('@') ? spec.indexOf('@', 1) >= 0 : spec.includes('@');
}

interface InstalledPackageLookup {
  getInstalledPath(source: string): string | undefined;
}

type ExtensionSourceScope = 'project' | 'user' | 'temporary';

interface ExtensionCandidateFailure {
  scope: ExtensionSourceScope;
  reason: string;
}

type ExtensionLoadError = LoadExtensionsResult['errors'][number];

interface ResolvedExtensionCandidate {
  scope: ExtensionSourceScope;
  paths: ResolvedPaths;
}

interface ExtensionSourceSearch {
  source: string;
  scopes: readonly ExtensionSourceScope[];
  nextScopeIndex: number;
  failures: ExtensionCandidateFailure[];
}

interface ExtensionSourceResolution extends ExtensionSourceSearch {
  candidate: ResolvedExtensionCandidate;
}

type ExtensionPackageManager = Pick<
  DefaultPackageManager,
  'getInstalledPath' | 'resolveExtensionSources'
>;

function createProjectInstalledPackageLookup(
  cwd: string,
  agentDir: string,
): InstalledPackageLookup {
  // This manager exists only to pass the SDK's project-storage trust guard for
  // a read-only existence lookup. Its settings are in-memory, it is never given
  // to the resource loader, and no mutating or resolving methods escape.
  const lookupSettingsManager = SettingsManager.inMemory({}, { projectTrusted: true });
  const lookupPackageManager = new DefaultPackageManager({
    cwd,
    agentDir,
    settingsManager: lookupSettingsManager,
  });
  const projectPackageRoot = path.resolve(cwd, '.pi', 'npm', 'node_modules');
  return {
    getInstalledPath: (source) => {
      const installedPath = lookupPackageManager.getInstalledPath(source, 'project');
      if (!installedPath) {
        return undefined;
      }
      let canonicalProjectPackageRoot: string;
      let canonicalInstalledPath: string;
      try {
        canonicalProjectPackageRoot = realpathSync(projectPackageRoot);
        canonicalInstalledPath = realpathSync(installedPath);
      } catch (error) {
        throw new Error(
          `Project package path could not be verified: ${getErrorMessage(error)}`,
          { cause: error },
        );
      }
      const relativePath = path.relative(canonicalProjectPackageRoot, canonicalInstalledPath);
      if (relativePath === '' || relativePath === '..' || relativePath.startsWith(`..${path.sep}`)
        || path.isAbsolute(relativePath)) {
        throw new Error('Project package path is outside project package storage');
      }
      return canonicalInstalledPath;
    },
  };
}

function extensionSourceDiagnosticLabel(source: string): string {
  const packageName = getSafeNpmPackageName(source);
  if (packageName !== undefined) {
    return `npm:${packageName}`;
  }
  const trimmed = source.trim();
  if (trimmed.startsWith('git:')) {
    return 'git source';
  }
  return 'local source';
}

function extensionCandidateFailureReason(error: unknown): string {
  const reason = safeExternalErrorMessage(error).trim();
  return reason || 'unknown resolution failure';
}

function recordExtensionCandidateFailure(
  source: string,
  failures: ExtensionCandidateFailure[],
  scope: ExtensionSourceScope,
  error: unknown,
): void {
  const reason = extensionCandidateFailureReason(error);
  failures.push({ scope, reason });
  log.debug('Pi extension candidate failed', {
    source: extensionSourceDiagnosticLabel(source),
    scope,
    reason,
  });
}

function formatExtensionSourceResolutionFailure(
  source: string,
  failures: readonly ExtensionCandidateFailure[],
): Error {
  const details = failures.length === 0
    ? ''
    : ` (${failures.map(({ scope, reason }) => `${scope}: ${reason}`).join('; ')})`;
  return new Error(
    `Pi extension source could not be resolved for ${extensionSourceDiagnosticLabel(source)}${details}`,
  );
}

function extensionSourceScopes(source: string): readonly ExtensionSourceScope[] {
  return isNpmExtensionSource(source) && !isVersionQualifiedNpmExtensionSource(source)
    ? ['project', 'user', 'temporary']
    : ['temporary'];
}

function createExtensionSourceSearch(source: string): ExtensionSourceSearch {
  return {
    source,
    scopes: extensionSourceScopes(source),
    nextScopeIndex: 0,
    failures: [],
  };
}

function createPiResourceLoader(
  cwd: string,
  agentDir: string,
  options: PiCallOptions,
  settingsManager: SettingsManager,
  resolvedResources: ResolvedPaths,
): DefaultResourceLoader {
  const providerOptions = options.providerOptions;
  return new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    additionalExtensionPaths: enabledResourcePaths(resolvedResources, 'extensions'),
    additionalSkillPaths: enabledResourcePaths(resolvedResources, 'skills'),
    additionalPromptTemplatePaths: enabledResourcePaths(resolvedResources, 'prompts'),
    additionalThemePaths: enabledResourcePaths(resolvedResources, 'themes'),
    noExtensions: providerOptions?.noExtensions,
    noSkills: providerOptions?.noSkills,
    noPromptTemplates: providerOptions?.noPromptTemplates,
    noThemes: providerOptions?.noThemes,
    noContextFiles: providerOptions?.noContextFiles,
    ...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}),
  });
}

function throwPiSessionAborted(): never {
  throw new Error('Pi session aborted');
}

function assertPiSessionNotAborted(abortSignal: AbortSignal | undefined): void {
  if (isAbortRequested(abortSignal)) {
    throwPiSessionAborted();
  }
}

function candidateSourceForScope(
  packageManager: ExtensionPackageManager,
  projectLookup: InstalledPackageLookup,
  source: string,
  scope: ExtensionSourceScope,
): string | undefined {
  switch (scope) {
    case 'project':
      return projectLookup.getInstalledPath(source);
    case 'user':
      return packageManager.getInstalledPath(source, 'user');
    case 'temporary':
      return source;
  }
}

async function resolveNextExtensionCandidate(
  packageManager: ExtensionPackageManager,
  projectLookup: InstalledPackageLookup,
  search: ExtensionSourceSearch,
  abortSignal: AbortSignal | undefined,
): Promise<ResolvedExtensionCandidate> {
  while (search.nextScopeIndex < search.scopes.length) {
    const scope = search.scopes[search.nextScopeIndex];
    if (scope === undefined) {
      break;
    }
    search.nextScopeIndex += 1;
    try {
      const candidateSource = candidateSourceForScope(
        packageManager,
        projectLookup,
        search.source,
        scope,
      );
      assertPiSessionNotAborted(abortSignal);
      if (candidateSource === undefined) {
        continue;
      }
      const paths = await packageManager.resolveExtensionSources(
        [candidateSource],
        { temporary: true },
      );
      assertPiSessionNotAborted(abortSignal);
      if (countEnabledResolvedResources(paths) === 0) {
        recordExtensionCandidateFailure(
          search.source,
          search.failures,
          scope,
          'no enabled resources',
        );
        continue;
      }
      return { scope, paths };
    } catch (error) {
      if (isAbortRequested(abortSignal)) {
        throwPiSessionAborted();
      }
      recordExtensionCandidateFailure(
        search.source,
        search.failures,
        scope,
        error,
      );
    }
  }

  throw formatExtensionSourceResolutionFailure(search.source, search.failures);
}

function mergeExtensionSourcePaths(
  resolutions: readonly ExtensionSourceResolution[],
): ResolvedPaths {
  return resolutions.reduce<ResolvedPaths>(
    (resolved, resolution) => mergeResolvedPaths(resolved, resolution.candidate.paths),
    { extensions: [], skills: [], prompts: [], themes: [] },
  );
}

function extensionPathKey(cwd: string, extensionPath: string): string {
  return path.resolve(cwd, extensionPath);
}

function failedExtensionSources(
  cwd: string,
  resolutions: readonly ExtensionSourceResolution[],
  loadErrors: readonly ExtensionLoadError[],
): Set<ExtensionSourceResolution> | undefined {
  const ownersByPath = new Map<string, ExtensionSourceResolution[]>();
  for (const resolution of resolutions) {
    for (const extensionPath of enabledResourcePaths(resolution.candidate.paths, 'extensions')) {
      const key = extensionPathKey(cwd, extensionPath);
      ownersByPath.set(key, [...(ownersByPath.get(key) ?? []), resolution]);
    }
  }

  const failedResolutions = new Set<ExtensionSourceResolution>();
  for (const loadError of loadErrors) {
    const owners = ownersByPath.get(extensionPathKey(cwd, loadError.path));
    if (owners?.length !== 1) {
      return undefined;
    }
    const owner = owners[0];
    if (owner === undefined) {
      return undefined;
    }
    failedResolutions.add(owner);
  }
  return failedResolutions;
}

function actualExtensionLoadErrors(
  cwd: string,
  extensionsResult: LoadExtensionsResult,
): ExtensionLoadError[] {
  const loadedExtensionPaths = new Set(
    extensionsResult.extensions.map((extension) => extensionPathKey(cwd, extension.path)),
  );
  return extensionsResult.errors.filter((error) => (
    !loadedExtensionPaths.has(extensionPathKey(cwd, error.path))
  ));
}

function loadErrorsForResolution(
  cwd: string,
  resolution: ExtensionSourceResolution,
  loadErrors: readonly ExtensionLoadError[],
): ExtensionLoadError[] {
  const candidatePaths = new Set(
    enabledResourcePaths(resolution.candidate.paths, 'extensions')
      .map((extensionPath) => extensionPathKey(cwd, extensionPath)),
  );
  return loadErrors.filter((loadError) => candidatePaths.has(extensionPathKey(cwd, loadError.path)));
}

function invalidateRejectedResourceLoader(resourceLoader: DefaultResourceLoader): void {
  resourceLoader.getExtensions().runtime.invalidate('Pi extension candidate was rejected');
}

async function resolvePiResourceLoader(
  cwd: string,
  agentDir: string,
  options: PiCallOptions,
  settingsManager: SettingsManager,
): Promise<DefaultResourceLoader> {
  assertPiSessionNotAborted(options.abortSignal);
  const sources = (options.providerOptions?.extensions ?? []).map((source) => source.trim());
  if (sources.length > 0) {
    assertSafeExtensionSources(sources);
  }

  const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
  const projectLookup = createProjectInstalledPackageLookup(cwd, agentDir);
  const resolutions: ExtensionSourceResolution[] = [];
  for (const search of sources.map(createExtensionSourceSearch)) {
    const candidate = await resolveNextExtensionCandidate(
      packageManager,
      projectLookup,
      search,
      options.abortSignal,
    );
    resolutions.push({ ...search, candidate });
  }

  while (true) {
    assertPiSessionNotAborted(options.abortSignal);
    const resolved = mergeExtensionSourcePaths(resolutions);
    const resourceLoader = createPiResourceLoader(cwd, agentDir, options, settingsManager, resolved);
    try {
      assertPiSessionNotAborted(options.abortSignal);
      await resourceLoader.reload();
    } catch (error) {
      invalidateRejectedResourceLoader(resourceLoader);
      if (isAbortRequested(options.abortSignal)) {
        throwPiSessionAborted();
      }
      throw new Error(safeExternalErrorMessage(error), { cause: error });
    }
    if (isAbortRequested(options.abortSignal)) {
      invalidateRejectedResourceLoader(resourceLoader);
      throwPiSessionAborted();
    }

    const extensionsResult = resourceLoader.getExtensions();
    const loadErrors = actualExtensionLoadErrors(cwd, extensionsResult);
    if (loadErrors.length === 0) {
      return resourceLoader;
    }

    const failedResolutions = failedExtensionSources(cwd, resolutions, loadErrors);
    if (failedResolutions === undefined || failedResolutions.size === 0) {
      invalidateRejectedResourceLoader(resourceLoader);
      throw new Error(`Pi extension loading failed: ${formatExtensionLoadErrors(loadErrors)}`);
    }

    for (const resolution of failedResolutions) {
      const candidate = resolution.candidate;
      const candidateErrors = loadErrorsForResolution(cwd, resolution, loadErrors);
      recordExtensionCandidateFailure(
        resolution.source,
        resolution.failures,
        candidate.scope,
        `Pi extension loading failed: ${formatExtensionLoadErrors(candidateErrors)}`,
      );
    }

    invalidateRejectedResourceLoader(resourceLoader);
    for (const resolution of failedResolutions) {
      resolution.candidate = await resolveNextExtensionCandidate(
        packageManager,
        projectLookup,
        resolution,
        options.abortSignal,
      );
    }
  }
}

function inferImageMimeType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.png':
    default:
      return 'image/png';
  }
}

async function buildPiImages(
  attachments: readonly ProviderImageAttachment[] | undefined,
): Promise<ImageContent[]> {
  if (!attachments || attachments.length === 0) {
    return [];
  }

  validateProviderImageAttachments(attachments);
  return Promise.all(attachments.map(async (attachment) => {
    let data: Buffer;
    try {
      data = await readFile(attachment.path);
    } catch (error) {
      throw new Error(`Failed to read image attachment at ${attachment.path}`, { cause: error });
    }
    return {
      type: 'image' as const,
      data: data.toString('base64'),
      mimeType: inferImageMimeType(attachment.path),
    };
  }));
}

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .filter((part): part is { type: 'text'; text: string } => (
      part !== null
      && typeof part === 'object'
      && !Array.isArray(part)
      && (part as Record<string, unknown>).type === 'text'
      && typeof (part as Record<string, unknown>).text === 'string'
    ))
    .map((part) => part.text)
    .join('');
}

function extractAssistantText(message: unknown): string {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    return '';
  }
  const record = message as Record<string, unknown>;
  return record.role === 'assistant' ? extractTextContent(record.content) : '';
}

function extractToolResultText(result: unknown): string {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    return typeof result === 'string' ? result : '';
  }
  return extractTextContent((result as Record<string, unknown>).content);
}

function emitResult(
  onStream: StreamCallback | undefined,
  content: string,
  success: boolean,
  sessionId: string | undefined,
  failureCategory?: ReturnType<typeof createProviderErrorFailure>['category'],
  error?: string,
): void {
  onStream?.({
    type: 'result',
    data: {
      result: content,
      success,
      sessionId: sessionId ?? 'unknown',
      error: success ? undefined : error ?? content,
      ...(failureCategory !== undefined ? { failureCategory } : {}),
    },
  });
}

function createFailureResponse(
  agentType: string,
  error: unknown,
  options: PiCallOptions,
  sessionId: string | undefined,
): AgentResponse {
  const aborted = options.abortSignal?.aborted === true
    || (error instanceof Error && error.message === 'Pi session aborted');
  const detail = aborted
    ? classifyAbortSignalReason(options.abortSignal?.reason ?? error)
    : createProviderErrorFailure(sanitizeSensitiveText(getErrorMessage(error)));
  const content = formatAgentFailure(detail);
  emitResult(options.onStream, content, false, sessionId, detail.category, content);
  return {
    persona: agentType,
    status: 'error',
    content,
    error: content,
    failureCategory: detail.category,
    timestamp: new Date(),
    sessionId,
  };
}

function normalizeSessionCwd(cwd: string): string {
  const resolved = path.resolve(cwd);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function sessionCacheKey(sessionId: string, cwd: string): string {
  return `${normalizeSessionCwd(cwd)}\u0000${sessionId}`;
}

function stableEnvironment(
  environment: Readonly<Record<string, string>> | undefined,
): Array<[string, string]> | undefined {
  return environment === undefined
    ? undefined
    : Object.entries(environment).sort(([left], [right]) => left.localeCompare(right));
}

function stableJsonValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(stableJsonValue);
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableJsonValue(entry)]),
  );
}

function buildSessionConfigurationFingerprint(options: PiCallOptions, agentDir: string): string {
  return JSON.stringify({
    agentDir: normalizeSessionCwd(agentDir),
    systemPrompt: options.systemPrompt,
    providerOptions: stableJsonValue(options.providerOptions),
    childProcessEnv: stableEnvironment(options.childProcessEnv),
  });
}

function formatExtensionLoadErrors(
  errors: ReadonlyArray<{ path: string; error: string }>,
): string {
  return errors
    .map((error) => `extension: ${safeExternalErrorMessage(error.error)}`)
    .join('; ');
}

function formatExtensionRuntimeError(error: ExtensionError): string {
  return `extension (${error.event}): ${safeExternalErrorMessage(error.error)}`;
}

function registerPendingExtensionProviders(
  runtime: ModelRuntime,
  extensionsResult: LoadExtensionsResult,
): void {
  const errors: Array<{ path: string; error: string }> = [];
  const pendingProviders = extensionsResult.runtime.pendingProviderRegistrations.splice(0);
  const pendingNativeProviders = extensionsResult.runtime.pendingNativeProviderRegistrations.splice(0);
  for (const registration of pendingProviders) {
    try {
      runtime.registerProvider(registration.name, registration.config);
    } catch (error) {
      errors.push({ path: registration.extensionPath, error: getErrorMessage(error) });
    }
  }
  for (const registration of pendingNativeProviders) {
    try {
      runtime.registerNativeProvider(registration.provider);
    } catch (error) {
      errors.push({ path: registration.extensionPath, error: getErrorMessage(error) });
    }
  }
  if (errors.length > 0) {
    throw new Error(
      `Pi extension provider registration failed: ${formatExtensionLoadErrors(errors)}`,
    );
  }
}

async function applyPiModel(record: PiSessionRecord, modelReference: string | undefined): Promise<void> {
  if (!modelReference?.trim()) {
    return;
  }
  const resolved = resolvePiModel(modelReference, record.runtime);
  const currentModel = record.session.model;
  if (resolved.model !== undefined && (
    currentModel?.provider !== resolved.model.provider
    || currentModel?.id !== resolved.model.id
  )) {
    await record.session.setModel(resolved.model);
  }
  if (resolved.thinkingLevel !== undefined) {
    record.session.setThinkingLevel(resolved.thinkingLevel);
  }
}

async function shutdownPiSession(session: AgentSession): Promise<void> {
  try {
    if (session.hasExtensionHandlers('session_shutdown')) {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    }
  } finally {
    session.dispose();
  }
}

function disposePiSessionRecord(record: PiSessionRecord): Promise<void> {
  if (record.disposed) {
    return record.disposalPromise ?? Promise.resolve();
  }
  record.disposed = true;
  record.disposalPromise = shutdownPiSession(record.session).catch(() => undefined);
  return record.disposalPromise;
}

function retireSessionRecord(record: PiSessionRecord): Promise<void> {
  if (record.retired) {
    return record.disposalPromise ?? Promise.resolve();
  }
  record.retired = true;
  for (const [key, value] of sessions) {
    if (value === record) {
      sessions.delete(key);
    }
  }
  if (record.activeOperations === 0) {
    return disposePiSessionRecord(record);
  }
  return Promise.resolve();
}

function enforcePiSessionCacheLimit(): void {
  const records = [...new Set(sessions.values())];
  if (records.length <= MAX_CACHED_PI_SESSIONS) {
    return;
  }
  const evictable = records
    .filter((candidate) => !candidate.retired && candidate.activeOperations === 0)
    .sort((left, right) => left.lastUsedAt - right.lastUsedAt);
  for (const candidate of evictable) {
    if (new Set(sessions.values()).size <= MAX_CACHED_PI_SESSIONS) {
      break;
    }
    void retireSessionRecord(candidate);
  }
}

function cacheSessionRecord(record: PiSessionRecord, sessionIds: readonly string[]): void {
  for (const sessionId of new Set(sessionIds)) {
    const key = sessionCacheKey(sessionId, record.cwd);
    const previous = sessions.get(key);
    if (previous !== undefined && previous !== record) {
      void retireSessionRecord(previous);
    }
    sessions.set(key, record);
  }

  enforcePiSessionCacheLimit();
}

async function createPiSession(
  options: PiCallOptions,
  agentDir: string,
  configurationFingerprint: string,
): Promise<PiSessionRecord> {
  if (isAbortRequested(options.abortSignal)) {
    throw new Error('Pi session aborted');
  }
  // Explicit provider options are trusted input. Project-local Pi resources are
  // not: keep implicit .pi discovery disabled while loading only explicitly
  // resolved extension paths through additionalExtensionPaths.
  const settingsManager = SettingsManager.inMemory({}, { projectTrusted: false });
  const runtime = await createModelRuntime(agentDir);
  if (isAbortRequested(options.abortSignal)) {
    throw new Error('Pi session aborted');
  }
  const resourceLoader = await resolvePiResourceLoader(
    options.cwd,
    agentDir,
    options,
    settingsManager,
  );
  let result: Awaited<ReturnType<typeof createAgentSession>>;
  try {
    if (isAbortRequested(options.abortSignal)) {
      throw new Error('Pi session aborted');
    }
    const extensionsResult = resourceLoader.getExtensions();
    const loadErrors = extensionsResult.errors;
    if (loadErrors.length > 0) {
      throw new Error(`Pi extension loading failed: ${formatExtensionLoadErrors(loadErrors)}`);
    }
    registerPendingExtensionProviders(runtime, extensionsResult);
    const sessionManager = SessionManager.inMemory(
      options.cwd,
      options.sessionId === undefined ? undefined : { id: options.sessionId },
    );

    const bashTool = createBashToolDefinition(options.cwd, {
      spawnHook: (context) => ({
        ...context,
        env: buildEnvWithNestedObservabilitySnapshot(context.env, options.childProcessEnv),
      }),
    }) as unknown as NonNullable<CreateAgentSessionOptions['customTools']>[number];
    result = await createAgentSession({
      cwd: options.cwd,
      agentDir,
      modelRuntime: runtime,
      resourceLoader,
      sessionManager,
      settingsManager,
      customTools: [bashTool],
    });
  } catch (error) {
    // No session owns the loader yet, so release event-bus subscriptions from
    // an extension factory when setup or session creation fails.
    invalidateRejectedResourceLoader(resourceLoader);
    throw error;
  }
  try {
    if (isAbortRequested(options.abortSignal)) {
      throw new Error('Pi session aborted');
    }
    if (result.extensionsResult.errors.length > 0) {
      throw new Error(
        `Pi extension loading failed: ${formatExtensionLoadErrors(result.extensionsResult.errors)}`,
      );
    }

    const extensionErrors: string[] = [];
    await result.session.bindExtensions({
      mode: 'print',
      onError: (error) => extensionErrors.push(formatExtensionRuntimeError(error)),
    });
    if (isAbortRequested(options.abortSignal)) {
      throw new Error('Pi session aborted');
    }
    if (extensionErrors.length > 0) {
      throw new Error(`Pi extension startup failed: ${extensionErrors.join('; ')}`);
    }

    const record: PiSessionRecord = {
      session: result.session,
      runtime,
      cwd: options.cwd,
      configurationFingerprint,
      extensionErrors,
      operationTail: Promise.resolve(),
      activeOperations: 0,
      lastUsedAt: Date.now(),
      retired: false,
      disposed: false,
    };
    await applyPiModel(record, options.model);
    return record;
  } catch (error) {
    await shutdownPiSession(result.session).catch(() => undefined);
    throw error;
  }
}

function releasePiSessionCreationHandoff(creation: PiSessionCreation): void {
  if (!creation.handoffLeaseHeld || creation.record === undefined) {
    return;
  }
  creation.handoffLeaseHeld = false;
  creation.record.activeOperations -= 1;
  if (creation.record.retired && creation.record.activeOperations === 0) {
    void disposePiSessionRecord(creation.record);
  } else if (creation.record.activeOperations === 0) {
    enforcePiSessionCacheLimit();
  }
}

async function waitForPiSessionCreation(
  key: string,
  creation: PiSessionCreation,
  abortSignal: AbortSignal | undefined,
): Promise<PiSessionRecord> {
  creation.waiters += 1;
  try {
    let record: PiSessionRecord;
    if (abortSignal === undefined) {
      record = await creation.promise;
    } else if (abortSignal.aborted) {
      throw new Error('Pi session aborted');
    } else {
      record = await new Promise<PiSessionRecord>((resolve, reject) => {
        const onAbort = (): void => {
          abortSignal.removeEventListener('abort', onAbort);
          reject(new Error('Pi session aborted'));
        };
        abortSignal.addEventListener('abort', onAbort, { once: true });
        void creation.promise.then(
          (created) => {
            abortSignal.removeEventListener('abort', onAbort);
            resolve(created);
          },
          (error: unknown) => {
            abortSignal.removeEventListener('abort', onAbort);
            reject(error instanceof Error ? error : new Error(String(error)));
          },
        );
      });
    }
    record.activeOperations += 1;
    return record;
  } finally {
    creation.waiters -= 1;
    if (creation.waiters === 0) {
      if (!creation.settled) {
        creation.abortController.abort('All Pi session creation waiters aborted');
      }
      releasePiSessionCreationHandoff(creation);
      if (sessionCreations.get(key) === creation) {
        sessionCreations.delete(key);
      }
    }
  }
}

function startPiSessionCreation(
  key: string,
  requestedSessionId: string,
  options: PiCallOptions,
  agentDir: string,
  configurationFingerprint: string,
): PiSessionCreation {
  const abortController = new AbortController();
  const creation = {
    abortController,
    waiters: 0,
    settled: false,
    handoffLeaseHeld: false,
  } as PiSessionCreation;
  creation.promise = createPiSession(
    { ...options, abortSignal: abortController.signal },
    agentDir,
    configurationFingerprint,
  ).then(
    (record) => {
      creation.settled = true;
      if (
        abortController.signal.aborted
        || sessionCreations.get(key) !== creation
      ) {
        record.retired = true;
        void disposePiSessionRecord(record);
        throw new Error('Pi session aborted');
      }
      creation.record = record;
      creation.handoffLeaseHeld = true;
      record.activeOperations += 1;
      cacheSessionRecord(record, [record.session.sessionId, requestedSessionId]);
      return record;
    },
    (error: unknown) => {
      creation.settled = true;
      throw error;
    },
  );
  void creation.promise.catch(() => undefined);
  sessionCreations.set(key, creation);
  return creation;
}

async function getOrCreatePiSession(options: PiCallOptions): Promise<PiSessionRecord> {
  const agentDir = getAgentDir();
  const configurationFingerprint = buildSessionConfigurationFingerprint(options, agentDir);
  if (options.sessionId !== undefined) {
    const requestedSessionId = options.sessionId;
    const key = sessionCacheKey(requestedSessionId, options.cwd);
    const existing = sessions.get(key);
    if (existing?.configurationFingerprint === configurationFingerprint && !existing.retired) {
      existing.lastUsedAt = Date.now();
      existing.activeOperations += 1;
      return existing;
    }
    if (existing !== undefined) {
      await retireSessionRecord(existing);
    }

    const creationKey = `${key}\u0000${configurationFingerprint}`;
    const creation = sessionCreations.get(creationKey)
      ?? startPiSessionCreation(
        creationKey,
        requestedSessionId,
        options,
        agentDir,
        configurationFingerprint,
      );
    return waitForPiSessionCreation(creationKey, creation, options.abortSignal);
  }

  const record = await createPiSession(options, agentDir, configurationFingerprint);
  record.activeOperations += 1;
  cacheSessionRecord(record, [record.session.sessionId]);
  return record;
}

async function runWithPiSessionLock<T>(
  record: PiSessionRecord,
  abortSignal: AbortSignal | undefined,
  action: () => Promise<T>,
): Promise<T> {
  const previous = record.operationTail.catch(() => undefined);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  record.operationTail = previous.then(() => gate);
  try {
    if (abortSignal === undefined) {
      await previous;
    } else if (abortSignal.aborted) {
      throw new Error('Pi session aborted');
    } else {
      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => {
          abortSignal.removeEventListener('abort', onAbort);
          reject(new Error('Pi session aborted'));
        };
        abortSignal.addEventListener('abort', onAbort, { once: true });
        void previous.then(() => {
          abortSignal.removeEventListener('abort', onAbort);
          resolve();
        });
      });
    }
    if (record.retired) {
      throw new Error('Pi session configuration changed while the call was waiting');
    }
    record.lastUsedAt = Date.now();
    return await action();
  } finally {
    release();
    record.activeOperations -= 1;
    record.lastUsedAt = Date.now();
    if (record.retired && record.activeOperations === 0) {
      await disposePiSessionRecord(record);
    } else if (record.activeOperations === 0) {
      enforcePiSessionCacheLimit();
    }
  }
}

interface PiTurnState {
  responseText: string;
  assistantError?: string;
  assistantAborted: boolean;
  partialToolOutput: Map<string, string>;
}

function handlePiEvent(
  event: AgentSessionEvent,
  options: PiCallOptions,
  state: PiTurnState,
): void {
  if (event.type === 'message_update') {
    const update = event.assistantMessageEvent;
    if (update.type === 'text_delta') {
      state.responseText += update.delta;
      options.onStream?.({ type: 'text', data: { text: update.delta } });
    } else if (update.type === 'thinking_delta') {
      options.onStream?.({ type: 'thinking', data: { thinking: update.delta } });
    }
    return;
  }

  if (event.type === 'tool_execution_start') {
    options.onStream?.({
      type: 'tool_use',
      data: {
        tool: event.toolName,
        input: event.args as Record<string, unknown>,
        id: event.toolCallId,
      },
    });
    return;
  }

  if (event.type === 'tool_execution_update') {
    const output = extractToolResultText(event.partialResult);
    const previous = state.partialToolOutput.get(event.toolCallId) ?? '';
    const delta = output.startsWith(previous) ? output.slice(previous.length) : output;
    state.partialToolOutput.set(event.toolCallId, output);
    if (!delta) {
      return;
    }
    options.onStream?.({
      type: 'tool_output',
      data: {
        tool: event.toolName,
        output: delta,
        id: event.toolCallId,
      },
    });
    return;
  }

  if (event.type === 'tool_execution_end') {
    state.partialToolOutput.delete(event.toolCallId);
    options.onStream?.({
      type: 'tool_result',
      data: {
        id: event.toolCallId,
        content: extractToolResultText(event.result),
        isError: event.isError,
      },
    });
    return;
  }

  if (event.type === 'message_end') {
    const message = event.message as unknown as Record<string, unknown>;
    if (message.role === 'assistant') {
      const text = extractAssistantText(message);
      if (text) {
        state.responseText = text;
      }
      if (message.stopReason === 'error') {
        state.assistantError = typeof message.errorMessage === 'string'
          ? message.errorMessage
          : 'Pi assistant message ended with an error';
      } else if (message.stopReason === 'aborted') {
        state.assistantAborted = true;
      } else {
        state.assistantError = undefined;
        state.assistantAborted = false;
      }
    }
    return;
  }

  if (event.type === 'agent_end') {
    const messages = event.messages;
    const lastAssistant = [...messages].reverse().find((message) => message.role === 'assistant');
    if (lastAssistant) {
      const message = lastAssistant as unknown as Record<string, unknown>;
      const text = extractAssistantText(message);
      if (text) {
        state.responseText = text;
      }
      if (message.stopReason === 'error') {
        state.assistantError = typeof message.errorMessage === 'string'
          ? message.errorMessage
          : 'Pi assistant message ended with an error';
      } else if (message.stopReason === 'aborted') {
        state.assistantAborted = true;
      } else {
        state.assistantError = undefined;
        state.assistantAborted = false;
      }
    }
  }
}

export async function callPi(
  agentType: string,
  prompt: string,
  options: PiCallOptions,
): Promise<AgentResponse> {
  let sessionId = options.sessionId;

  try {
    if (isAbortRequested(options.abortSignal)) {
      throw new Error('Pi session aborted');
    }
    const record = await getOrCreatePiSession(options);
    const activeSessionId = record.session.sessionId;
    sessionId = activeSessionId;
    return await runWithPiSessionLock(record, options.abortSignal, async () => {
      const session = record.session;
      if (isAbortRequested(options.abortSignal)) {
        await retireSessionRecord(record);
        throw new Error('Pi session aborted');
      }
      if (record.extensionErrors.length > 0) {
        throw new Error(`Pi extension failed: ${record.extensionErrors.splice(0).join('; ')}`);
      }
      await applyPiModel(record, options.model);
      applyPiTools(session, options);
      const state: PiTurnState = {
        responseText: '',
        assistantError: undefined,
        assistantAborted: false,
        partialToolOutput: new Map(),
      };
      const initialMessageCount = session.messages.length;
      const unsubscribe = session.subscribe((event) => handlePiEvent(event, options, state));
      let rejectPromptAbort: ((error: unknown) => void) | undefined;
      let abortCleanup: Promise<void> | undefined;
      let abortStarted = false;
      const promptAbort = new Promise<never>((_resolve, reject) => {
        rejectPromptAbort = reject;
      });
      promptAbort.catch(() => undefined);
      const onAbort = (): void => {
        if (abortStarted) {
          return;
        }
        abortStarted = true;
        // Retire before releasing the session lock so a following call cannot
        // acquire this session while the SDK is still stopping it.
        void retireSessionRecord(record);
        abortCleanup = Promise.resolve()
          .then(() => session.abort())
          .then(() => undefined)
          .catch(() => undefined);
        rejectPromptAbort?.(new Error('Pi session aborted'));
      };

      options.onStream?.({
        type: 'init',
        data: {
          model: session.model ? `${session.model.provider}/${session.model.id}` : options.model ?? 'pi',
          sessionId: activeSessionId,
        },
      });

      try {
        options.abortSignal?.addEventListener('abort', onAbort, { once: true });
        if (isAbortRequested(options.abortSignal)) {
          onAbort();
          throw new Error('Pi session aborted');
        }
        const images = await buildPiImages(options.imageAttachments);
        if (isAbortRequested(options.abortSignal)) {
          onAbort();
          throw new Error('Pi session aborted');
        }
        const imagePrompt = options.imageAttachments && options.imageAttachments.length > 0
          ? `${prompt}\n\n${options.imageAttachments.map((attachment) => attachment.placeholder).join('\n')}`
          : prompt;
        options.onActivity?.({ kind: 'attempt_started' });
        const promptPromise = session.prompt(
          imagePrompt,
          images.length > 0 ? { images } : undefined,
        );
        await Promise.race([promptPromise, promptAbort]);
      } finally {
        options.abortSignal?.removeEventListener('abort', onAbort);
        unsubscribe();
        if (abortCleanup !== undefined) {
          await awaitAbortCleanup(abortCleanup);
        }
      }

      if (isAbortRequested(options.abortSignal) || state.assistantAborted) {
        throw new Error('Pi session aborted');
      }
      if (state.assistantError !== undefined) {
        throw new Error(state.assistantError);
      }
      if (record.extensionErrors.length > 0) {
        throw new Error(`Pi extension failed: ${record.extensionErrors.splice(0).join('; ')}`);
      }

      if (!state.responseText) {
        const newMessages = session.messages.slice(initialMessageCount);
        const lastAssistant = [...newMessages].reverse().find((message) => message.role === 'assistant');
        state.responseText = extractAssistantText(lastAssistant);
      }
      if (!state.responseText) {
        throw new Error('Pi SDK returned no assistant text');
      }

      emitResult(options.onStream, state.responseText, true, activeSessionId);
      return {
        persona: agentType,
        status: 'done',
        content: state.responseText,
        timestamp: new Date(),
        sessionId: activeSessionId,
      };
    });
  } catch (error) {
    return createFailureResponse(agentType, error, options, sessionId);
  }
}
