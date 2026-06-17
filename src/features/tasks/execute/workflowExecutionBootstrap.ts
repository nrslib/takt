import { join } from 'node:path';
import { CapabilityAwareStructuredCaller } from '../../../agents/structured-caller.js';
import type { WorkflowConfig } from '../../../core/models/index.js';
import type { ResolvedObservabilityConfig } from '../../../core/models/config-types.js';
import { buildRunPaths } from '../../../core/workflow/run/run-paths.js';
import { resolveRuntimeConfig } from '../../../core/runtime/runtime-environment.js';
import {
  loadPersonaSessions,
  loadWorktreeSessions,
  resolveWorkflowConfigValues,
  updatePersonaSession,
  updateWorktreeSession,
} from '../../../infra/config/index.js';
import {
  resolveConfigValueWithSource,
  type ConfigValueSource,
} from '../../../infra/config/resolveConfigValue.js';
import type { ProviderResolutionSource } from '../../../core/workflow/provider-options-trace.js';
import {
  buildTraceDiscovery,
  type WorkflowTraceDiscovery,
} from '../../../core/workflow/observability/traceDiscovery.js';
import { getGlobalConfigDir } from '../../../infra/config/paths.js';
import { createSessionLog, generateSessionId, initNdjsonLog, type SessionLog } from '../../../infra/fs/index.js';
import { isQuietMode } from '../../../shared/context.js';
import { StreamDisplay } from '../../../shared/ui/index.js';
import { TaskPrefixWriter } from '../../../shared/ui/TaskPrefixWriter.js';
import { createLogger, generateReportDir, getDebugPromptsLogFile, isValidReportDirName, preventSleep } from '../../../shared/utils/index.js';
import { createProviderEventLogger, isProviderEventsEnabled } from '../../../shared/utils/providerEventLogger.js';
import { sanitizeTerminalText } from '../../../shared/utils/text.js';
import { createUsageEventLogger, isUsageEventsEnabled } from '../../../shared/utils/usageEventLogger.js';
import { initializeOtelFoundation, type OtelFoundationHandle } from '../../../infra/observability/otelFoundation.js';
import { PHASE_USAGE_EVENTS_LOG_FILE_SUFFIX } from '../../../core/logging/contracts.js';
import { initAnalyticsWriter } from '../../analytics/index.js';
import { AnalyticsEmitter } from './analyticsEmitter.js';
import { createOutputFns, createPrefixedStreamHandler } from './outputFns.js';
import { RunMetaManager } from './runMeta.js';
import { SessionLogger } from './sessionLogger.js';
import { createTraceReportWriter } from './traceReportWriter.js';
import { sanitizeTextForStorage } from './traceReportRedaction.js';
import type { WorkflowExecutionOptions } from './types.js';
import { assertTaskPrefixPair, detectStepType } from './workflowExecutionUtils.js';

const log = createLogger('workflow');

type DisplayStreamEvent = Parameters<ReturnType<StreamDisplay['createHandler']>>[0];

export interface WorkflowExecutionBootstrap {
  interactiveUserInput: boolean;
  prefixWriter: TaskPrefixWriter | undefined;
  out: ReturnType<typeof createOutputFns>;
  displayRef: { current: StreamDisplay | null };
  handlerRef: { current: ReturnType<StreamDisplay['createHandler']> | null };
  streamHandler: (event: DisplayStreamEvent) => void;
  isRetry: boolean;
  isWorktree: boolean;
  runSlug: string;
  runPaths: ReturnType<typeof buildRunPaths>;
  runMetaManager: RunMetaManager;
  traceDiscovery?: WorkflowTraceDiscovery;
  sessionLog: SessionLog;
  ndjsonLogPath: string;
  sessionLogger: SessionLogger;
  sanitizeObservabilityText: (text: string) => string;
  shouldNotifyIterationLimit: boolean;
  shouldNotifyWorkflowComplete: boolean;
  shouldNotifyWorkflowAbort: boolean;
  currentProvider: WorkflowExecutionOptions['provider'];
  currentProviderSource: ProviderResolutionSource;
  configuredModel: string | undefined;
  configuredModelSource: ProviderResolutionSource;
  effectiveWorkflowConfig: WorkflowConfig;
  providerEventLogger: ReturnType<typeof createProviderEventLogger>;
  usageEventLogger: ReturnType<typeof createUsageEventLogger>;
  observability: ResolvedObservabilityConfig;
  observabilityHandle: OtelFoundationHandle;
  analyticsEmitter: AnalyticsEmitter;
  structuredCaller: CapabilityAwareStructuredCaller;
  savedSessions: Record<string, string>;
  sessionUpdateHandler: (persona: string, sessionId: string) => void;
  writeTraceReportOnce: ReturnType<typeof createTraceReportWriter>;
}

export async function createWorkflowExecutionBootstrap(
  workflowConfig: WorkflowConfig,
  task: string,
  cwd: string,
  options: WorkflowExecutionOptions,
): Promise<WorkflowExecutionBootstrap> {
  const { headerPrefix = 'Running Workflow:', interactiveUserInput = false } = options;
  const projectCwd = options.projectCwd;
  const safeWorkflowName = sanitizeTerminalText(workflowConfig.name);

  assertTaskPrefixPair(options.taskPrefix, options.taskColorIndex);

  const prefixWriter = options.taskPrefix != null
    ? new TaskPrefixWriter({
        taskName: options.taskPrefix,
        colorIndex: options.taskColorIndex!,
        displayLabel: options.taskDisplayLabel,
      })
    : undefined;
  const out = createOutputFns(prefixWriter);
  out.header(`${headerPrefix} ${safeWorkflowName}`);

  const displayRef = { current: null as StreamDisplay | null };
  const handlerRef = { current: null as ReturnType<StreamDisplay['createHandler']> | null };
  const streamHandler = prefixWriter
    ? createPrefixedStreamHandler(prefixWriter)
    : (event: DisplayStreamEvent): void => {
        if (!displayRef.current || event.type === 'result') {
          return;
        }
        if (!handlerRef.current) {
          handlerRef.current = displayRef.current.createHandler();
        }
        handlerRef.current(event);
      };

  const isRetry = Boolean(options.startStep || options.retryNote || options.resumePoint);
  const isWorktree = cwd !== projectCwd;
  log.debug('Session mode', { isRetry, isWorktree });

  const runSlug = options.reportDirName ?? generateReportDir(task);
  if (!isValidReportDirName(runSlug)) {
    throw new Error(`Invalid reportDirName: ${runSlug}`);
  }

  const runPaths = buildRunPaths(cwd, runSlug);
  const sessionLog = createSessionLog(task, projectCwd, workflowConfig.name);
  const globalConfig = resolveWorkflowConfigValues(projectCwd, [
    'notificationSound',
    'notificationSoundEvents',
    'provider',
    'rateLimitFallback',
    'runtime',
    'preventSleep',
    'model',
    'logging',
    'analytics',
    'observability',
  ]);
  const traceReportMode = globalConfig.logging?.trace === true ? 'full' : 'redacted';
  const allowSensitiveData = traceReportMode === 'full';
  const sanitizeObservabilityText = (text: string): string => sanitizeTextForStorage(text, allowSensitiveData);
  const traceDiscovery = globalConfig.observability.enabled === true
    ? buildTraceDiscovery({
        runId: runSlug,
        workflowName: workflowConfig.name,
        traceTaskMetadata: {
          ...options.traceTaskMetadata,
          runDir: runPaths.runRootAbs,
        },
        sanitizeText: sanitizeObservabilityText,
      })
    : undefined;
  const runMetaManager = new RunMetaManager(
    runPaths,
    task,
    workflowConfig.name,
    options.directResume,
    traceDiscovery ? { traceDiscovery } : undefined,
  );
  const workflowSessionId = generateSessionId();
  const ndjsonLogPath = initNdjsonLog(
    workflowSessionId,
    sanitizeTextForStorage(task, allowSensitiveData),
    workflowConfig.name,
    { logsDir: runPaths.logsAbs },
  );
  const sessionLogger = new SessionLogger(ndjsonLogPath, allowSensitiveData);
  if (options.interactiveMetadata) {
    sessionLogger.writeInteractiveMetadata(options.interactiveMetadata);
  }

  const shouldNotify = globalConfig.notificationSound !== false;
  const shouldNotifyIterationLimit = shouldNotify && globalConfig.notificationSoundEvents?.iterationLimit !== false;
  const shouldNotifyWorkflowComplete = shouldNotify && globalConfig.notificationSoundEvents?.workflowComplete !== false;
  const shouldNotifyWorkflowAbort = shouldNotify && globalConfig.notificationSoundEvents?.workflowAbort !== false;
  const currentProvider = options.provider ?? globalConfig.provider;
  if (!currentProvider) {
    throw new Error('No provider configured. Set "provider" in ~/.takt/config.yaml');
  }
  const currentProviderSource = resolveProviderFieldSource(
    projectCwd,
    'provider',
    options.provider,
    options.providerSource,
  );

  const configuredModel = options.model ?? globalConfig.model;
  const configuredModelSource = resolveProviderFieldSource(
    projectCwd,
    'model',
    options.model,
    options.modelSource,
  );
  const effectiveWorkflowConfig: WorkflowConfig = {
    ...workflowConfig,
    rateLimitFallback: workflowConfig.rateLimitFallback ?? globalConfig.rateLimitFallback,
    runtime: resolveRuntimeConfig(globalConfig.runtime, workflowConfig.runtime),
    ...(options.maxStepsOverride !== undefined ? { maxSteps: options.maxStepsOverride } : {}),
  };
  const providerEventLogger = createProviderEventLogger({
    logsDir: runPaths.logsAbs,
    sessionId: workflowSessionId,
    runId: runSlug,
    provider: currentProvider,
    step: options.startStep ?? workflowConfig.initialStep,
    enabled: isProviderEventsEnabled(globalConfig),
  });
  const usageEventLogger = createUsageEventLogger({
    logsDir: runPaths.logsAbs,
    sessionId: workflowSessionId,
    runId: runSlug,
    provider: currentProvider,
    providerModel: configuredModel ?? '(default)',
    step: options.startStep ?? workflowConfig.initialStep,
    stepType: 'normal',
    enabled: isUsageEventsEnabled(globalConfig),
  });

  initAnalyticsWriter(
    globalConfig.analytics?.enabled === true,
    globalConfig.analytics?.eventsPath ?? join(getGlobalConfigDir(), 'analytics', 'events'),
  );
  if (globalConfig.preventSleep) {
    preventSleep();
  }

  const analyticsEmitter = new AnalyticsEmitter(runSlug, currentProvider, configuredModel ?? '(default)');
  const structuredCaller = new CapabilityAwareStructuredCaller();
  const savedSessions = isRetry
    ? (isWorktree
      ? loadWorktreeSessions(projectCwd, cwd, currentProvider)
      : loadPersonaSessions(projectCwd, currentProvider))
    : {};
  const sessionUpdateHandler = isWorktree
    ? (personaName: string, personaSessionId: string) =>
        updateWorktreeSession(projectCwd, cwd, personaName, personaSessionId, currentProvider)
    : (persona: string, personaSessionId: string) =>
        updatePersonaSession(projectCwd, persona, personaSessionId, currentProvider);
  const writeTraceReportOnce = createTraceReportWriter({
    sessionLogger,
    ndjsonLogPath,
    tracePath: join(runPaths.runRootAbs, 'trace.md'),
    workflowName: workflowConfig.name,
    task,
    runSlug,
    promptLogPath: getDebugPromptsLogFile() ?? undefined,
    mode: traceReportMode,
    logger: log,
  });
  const observabilityOptions = globalConfig.observability.enabled
    && (
      globalConfig.observability.sessionLogExporter
      || globalConfig.observability.monitor
      || globalConfig.observability.usageEventsPhase
    )
    ? {
        ...(globalConfig.observability.sessionLogExporter
          ? {
              sessionLogExporter: {
                runId: runSlug,
                shadowLogPath: join(runPaths.logsAbs, `${workflowSessionId}-otel-session-shadow.jsonl`),
                sanitizedTask: sanitizeTextForStorage(task, allowSensitiveData),
                workflowName: workflowConfig.name,
              },
            }
          : {}),
        ...(globalConfig.observability.usageEventsPhase
          ? {
              usageEventsExporter: {
                runId: runSlug,
                sessionId: workflowSessionId,
                phaseUsageLogPath: join(runPaths.logsAbs, `${workflowSessionId}${PHASE_USAGE_EVENTS_LOG_FILE_SUFFIX}`),
              },
            }
          : {}),
        ...(globalConfig.observability.monitor
          ? { monitorJsonExporter: { runId: runSlug, monitorPath: join(runPaths.runRootAbs, 'monitor.json') } }
          : {}),
      }
    : undefined;
  const observabilityHandle = await initializeOtelFoundation(
    globalConfig.observability,
    observabilityOptions,
  );

  return {
    interactiveUserInput,
    prefixWriter,
    out,
    displayRef,
    handlerRef,
    streamHandler,
    isRetry,
    isWorktree,
    runSlug,
    runPaths,
    runMetaManager,
    traceDiscovery,
    sessionLog,
    ndjsonLogPath,
    sessionLogger,
    sanitizeObservabilityText,
    shouldNotifyIterationLimit,
    shouldNotifyWorkflowComplete,
    shouldNotifyWorkflowAbort,
    currentProvider,
    currentProviderSource,
    configuredModel,
    configuredModelSource,
    effectiveWorkflowConfig,
    providerEventLogger,
    usageEventLogger,
    observability: globalConfig.observability,
    observabilityHandle,
    analyticsEmitter,
    structuredCaller,
    savedSessions,
    sessionUpdateHandler,
    writeTraceReportOnce,
  };
}

function mapConfigSourceToResolutionSource(source: ConfigValueSource): ProviderResolutionSource {
  switch (source) {
    case 'project':
      return 'project';
    case 'global':
      return 'global';
    case 'default':
      return 'default';
    default:
      // 'env' / 'workflow' do not occur for provider/model in bootstrap context.
      return 'default';
  }
}

function resolveProviderFieldSource(
  projectCwd: string,
  key: 'provider' | 'model',
  cliValue: string | undefined,
  cliSource: ProviderResolutionSource | undefined,
): ProviderResolutionSource {
  if (cliValue !== undefined) {
    return cliSource ?? 'cli';
  }
  try {
    const resolved = resolveConfigValueWithSource(projectCwd, key);
    if (resolved.value !== undefined) {
      return mapConfigSourceToResolutionSource(resolved.source);
    }
  } catch {
    // Config resolution may fail in test contexts where paths are synthetic;
    // fall back to 'global' as a reasonable default since the value itself
    // was loaded successfully via resolveWorkflowConfigValues.
  }
  return 'global';
}

export { detectStepType, isQuietMode };
