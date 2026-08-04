import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { CapabilityAwareStructuredCaller } from '../../../agents/structured-caller.js';
import type { WorkflowConfig } from '../../../core/models/index.js';
import type {
  FindingContractRuntimeConfig,
  ResolvedObservabilityConfig,
  TagRoutingConflictPolicy,
} from '../../../core/models/config-types.js';
import { buildRunPaths } from '../../../core/workflow/run/run-paths.js';
import { readRunMetaBySlug } from '../../../core/workflow/run/run-meta.js';
import {
  OperationLineageUnavailableError,
  OperationRecoveryError,
} from '../../../core/workflow/operations/operation-recovery-error.js';
import type { WorkflowOperationJournalContext } from '../../../core/workflow/types.js';
import {
  inheritResumeReportSnapshot,
  RESUME_ARTIFACTS_FILE_NAME,
  ResumeReportSnapshotSourceError,
} from '../../../core/workflow/run/resume-report-snapshot.js';
import { resolveRuntimeConfig } from '../../../core/runtime/runtime-environment.js';
import {
  loadGlobalConfig,
  loadPersonaSessions,
  loadProjectConfig,
  loadWorktreeSessions,
  resolveWorkflowConfigValues,
  updatePersonaSession,
  updateWorktreeSession,
} from '../../../infra/config/index.js';
import {
  resolveConfigValueWithSource,
} from '../../../infra/config/resolveConfigValue.js';
import type { ProviderResolutionSource } from '../../../core/workflow/provider-options-trace.js';
import {
  buildTraceDiscovery,
  type WorkflowTraceDiscovery,
} from '../../../core/workflow/observability/traceDiscovery.js';
import { getGlobalConfigDir } from '../../../infra/config/paths.js';
import { createSessionLog, initNdjsonLog, type SessionLog } from '../../../infra/fs/index.js';
import { isQuietMode } from '../../../shared/context.js';
import { StreamDisplay } from '../../../shared/ui/index.js';
import { TaskPrefixWriter } from '../../../shared/ui/TaskPrefixWriter.js';
import { getErrorMessage } from '../../../shared/utils/error.js';
import {
  createLogger,
  getDebugPromptsLogFile,
  isValidReportDirName,
  preventSleep,
} from '../../../shared/utils/index.js';
import { createProviderEventLogger, isProviderEventsEnabled } from '../../../core/logging/providerEventLogger.js';
import { sanitizeTerminalText } from '../../../shared/utils/text.js';
import { createUsageEventLogger, isUsageEventsEnabled } from '../../../core/logging/usageEventLogger.js';
import { initializeOtelFoundation, type OtelFoundationHandle } from '../../../infra/observability/otelFoundation.js';
import {
  OTEL_SESSION_SHADOW_LOG_FILE_SUFFIX,
  PHASE_USAGE_EVENTS_LOG_FILE_SUFFIX,
} from '../../../core/logging/contracts.js';
import {
  resolveEffectiveAutoRouting,
} from '../../../core/workflow/auto-routing/effective-auto-routing.js';
import { initAnalyticsWriter } from '../../analytics/index.js';
import { ensureWorktreeTaktRuntimeProtection } from '../../../infra/task/projectLocalTaktSync.js';
import { createOperationJournalStore } from '../../../infra/workflow/operation-journal-store.js';
import { AnalyticsEmitter } from './analyticsEmitter.js';
import { createOutputFns, createPrefixedStreamHandler } from './outputFns.js';
import type { RunMetaManager } from './runMeta.js';
import { SessionLogger } from './sessionLogger.js';
import type { TraceReportMode } from './traceReport.js';
import { sanitizeTextForStorage } from './traceReportRedaction.js';
import type { WorkflowExecutionOptions } from './types.js';
import { resolveCompiledProviderEnvironment } from '../../../infra/config/runtime-provider/provider-environment.js';
import {
  collectLegacyProviderSignals,
  selectConfigTaktProviders,
} from '../../../infra/config/runtime-provider/legacy-signals.js';
import type { LegacyProviderEnvironmentInput } from '../../../infra/config/runtime-provider/environment.js';
import { assertTaskPrefixPair, detectStepType } from './workflowExecutionUtils.js';
import type { WorkflowRunBootstrap } from './workflowRunLifecycle.js';
import { inheritWorkflowConfigMetadata } from '../../../shared/workflowConfigMetadata.js';

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
  shouldNotifyRateLimit: boolean;
  shouldNotifyWorkflowComplete: boolean;
  shouldNotifyWorkflowAbort: boolean;
  currentProvider: WorkflowExecutionOptions['provider'];
  currentProviderSource: ProviderResolutionSource;
  configuredModel: string | undefined;
  configuredModelSource: ProviderResolutionSource;
  personaProviders: WorkflowExecutionOptions['personaProviders'];
  providerRouting: WorkflowExecutionOptions['providerRouting'];
  providerRoutingTagConflictPolicy: TagRoutingConflictPolicy;
  providerOptions: WorkflowExecutionOptions['providerOptions'];
  effectiveWorkflowConfig: WorkflowConfig;
  findingContractConfig?: FindingContractRuntimeConfig;
  autoStrategyOverride: WorkflowExecutionOptions['autoStrategy'];
  onEffectiveAutoRoutingReached: () => void;
  warnIfAutoStrategyUnused: () => void;
  providerEventLogger: ReturnType<typeof createProviderEventLogger>;
  usageEventLogger: ReturnType<typeof createUsageEventLogger>;
  observability: ResolvedObservabilityConfig;
  observabilityHandle: OtelFoundationHandle;
  analyticsEmitter: AnalyticsEmitter;
  structuredCaller: CapabilityAwareStructuredCaller;
  savedSessions: Record<string, string>;
  sessionUpdateHandler: (persona: string, sessionId: string | undefined) => void;
  traceReportMode: TraceReportMode;
  promptLogPath?: string;
  operationJournal: WorkflowOperationJournalContext;
}

export interface WorkflowExecutionResumeLineage {
  readonly sourceRunSlug?: string;
  readonly publishedResumeSource?: WorkflowExecutionOptions['resumeSource'];
  readonly operationJournalRunSlug: string;
  readonly operationClaimToken: string;
  readonly sourceOperationClaimTokens?: ReadonlySet<string>;
}

class AutoRoutingReachTracker {
  private reached = false;

  markReached(): void {
    this.reached = true;
  }

  hasReached(): boolean {
    return this.reached;
  }
}

function resolveMaxStepsForRestoredIteration(
  currentMaxSteps: WorkflowConfig['maxSteps'],
  workflowMaxSteps: WorkflowConfig['maxSteps'],
  initialIteration: number | undefined,
): WorkflowConfig['maxSteps'] {
  if (
    currentMaxSteps === 'infinite'
    || initialIteration === undefined
    || initialIteration < currentMaxSteps
  ) {
    return currentMaxSteps;
  }

  if (workflowMaxSteps === 'infinite') {
    let resumedMaxSteps = currentMaxSteps;
    while (initialIteration >= resumedMaxSteps) {
      const nextMaxSteps = resumedMaxSteps * 2;
      if (!Number.isSafeInteger(nextMaxSteps)) {
        throw new Error('Cannot resume workflow because the next max steps limit exceeds the safe integer range');
      }
      resumedMaxSteps = nextMaxSteps;
    }
    return resumedMaxSteps;
  }

  const requiredIncrements = Math.floor(
    (initialIteration - currentMaxSteps) / workflowMaxSteps,
  ) + 1;
  const resumedMaxSteps = currentMaxSteps + requiredIncrements * workflowMaxSteps;
  if (!Number.isSafeInteger(resumedMaxSteps)) {
    throw new Error('Cannot resume workflow because the next max steps limit exceeds the safe integer range');
  }
  return resumedMaxSteps;
}

function resolveOperationJournalSourceClaims(
  cwd: string,
  immediateSourceRunSlug: string,
): {
  readonly journalRunSlug: string;
  readonly claimTokens: ReadonlySet<string>;
} {
  const visited = new Set<string>();
  const claimTokens = new Set<string>();
  let journalRunSlug: string | undefined;
  let sourceRunSlug: string | undefined = immediateSourceRunSlug;
  while (sourceRunSlug !== undefined) {
    if (!isValidReportDirName(sourceRunSlug)) {
      throw new OperationRecoveryError(
        `Resume source run slug "${sourceRunSlug}" is invalid`,
      );
    }
    if (visited.has(sourceRunSlug)) {
      throw new OperationRecoveryError(
        `Resume source run ancestry contains a cycle at "${sourceRunSlug}"`,
      );
    }
    visited.add(sourceRunSlug);
    const sourceMeta = readRunMetaBySlug(cwd, sourceRunSlug);
    if (sourceMeta === null) {
      throw new OperationLineageUnavailableError(
        `Resume source run "${sourceRunSlug}" is missing`,
      );
    }
    if (
      sourceMeta.operationJournalRunSlug === undefined
      || sourceMeta.operationClaimToken === undefined
    ) {
      throw new OperationLineageUnavailableError(
        `Source run "${sourceRunSlug}" has incomplete operation journal ownership metadata`,
      );
    }
    if (!isValidReportDirName(sourceMeta.operationJournalRunSlug)) {
      throw new OperationRecoveryError(
        `Source run "${sourceRunSlug}" has an invalid operation journal run slug`,
      );
    }
    if (
      journalRunSlug !== undefined
      && sourceMeta.operationJournalRunSlug !== journalRunSlug
    ) {
      throw new OperationRecoveryError(
        `Source run "${sourceRunSlug}" belongs to a different operation journal`,
      );
    }
    journalRunSlug = sourceMeta.operationJournalRunSlug;
    claimTokens.add(sourceMeta.operationClaimToken);
    sourceRunSlug = sourceMeta.sourceRunSlug;
  }
  if (journalRunSlug === undefined) {
    throw new OperationLineageUnavailableError(
      'Resume source ancestry has no operation journal',
    );
  }
  return {
    journalRunSlug,
    claimTokens,
  };
}

export function resolveWorkflowExecutionResumeLineage(
  cwd: string,
  runSlug: string,
  resumeSource: WorkflowExecutionOptions['resumeSource'],
): WorkflowExecutionResumeLineage {
  const sourceRunSlug = resumeSource?.sourceRunSlug;
  if (resumeSource === undefined || sourceRunSlug === undefined) {
    return {
      operationJournalRunSlug: runSlug,
      operationClaimToken: randomUUID(),
      ...(resumeSource === undefined ? {} : { publishedResumeSource: resumeSource }),
    };
  }

  try {
    return resolveWorkflowExecutionResumeSourceLineage(cwd, resumeSource);
  } catch (error) {
    if (!(error instanceof OperationLineageUnavailableError)) {
      throw error;
    }
    log.warn(
      'Resume source operation lineage is unavailable; starting a new operation journal',
      {
        sourceRunSlug,
        targetRunSlug: runSlug,
        reason: getErrorMessage(error),
      },
    );
    return {
      sourceRunSlug,
      publishedResumeSource: resumeSource,
      operationJournalRunSlug: runSlug,
      operationClaimToken: randomUUID(),
    };
  }
}

export function resolveWorkflowExecutionResumeSourceLineage(
  cwd: string,
  resumeSource: NonNullable<WorkflowExecutionOptions['resumeSource']>,
): WorkflowExecutionResumeLineage {
  const sourceRunSlug = resumeSource.sourceRunSlug;
  if (sourceRunSlug === undefined) {
    throw new OperationRecoveryError(
      'Workflow resume requires a source run slug with operation lineage',
    );
  }

  const sourceClaims = resolveOperationJournalSourceClaims(cwd, sourceRunSlug);
  return {
    sourceRunSlug,
    publishedResumeSource: resumeSource,
    operationJournalRunSlug: sourceClaims.journalRunSlug,
    operationClaimToken: randomUUID(),
    sourceOperationClaimTokens: sourceClaims.claimTokens,
  };
}

export async function createWorkflowExecutionBootstrap(
  workflowConfig: WorkflowConfig,
  task: string,
  cwd: string,
  options: WorkflowExecutionOptions,
  runBootstrap: WorkflowRunBootstrap,
  resumeLineage: WorkflowExecutionResumeLineage,
): Promise<WorkflowExecutionBootstrap> {
  const effectiveMaxSteps = resolveMaxStepsForRestoredIteration(
    options.maxStepsOverride ?? workflowConfig.maxSteps,
    workflowConfig.maxSteps,
    options.initialIterationOverride,
  );
  const { headerPrefix = 'Running Workflow:', interactiveUserInput = false, outputMode = 'terminal' } = options;
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
  const out = createOutputFns(prefixWriter, outputMode);
  out.header(`${headerPrefix} ${safeWorkflowName}`);

  const displayRef = { current: null as StreamDisplay | null };
  const handlerRef = { current: null as ReturnType<StreamDisplay['createHandler']> | null };
  const streamHandler = outputMode === 'silent'
    ? (): void => {}
    : prefixWriter
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

  const isRetry = Boolean(options.startStep || options.retryNote || options.resumePoint || options.restartPoint);
  const shouldLoadSavedSessions = isRetry && options.restartPoint === undefined;
  const isWorktree = cwd !== projectCwd;
  log.debug('Session mode', { isRetry, isWorktree });

  const { runSlug, runPaths } = runBootstrap;
  if (isWorktree) {
    ensureWorktreeTaktRuntimeProtection(cwd);
  }

  // resume（requeue / retry / instruct、attachment 有無を問わず）は source と
  // 異なる run slug を使う。旧 run の reports/ を継承しないと {report:X}
  // 参照が壊れるため、bootstrap を一元境界にして配線漏れを防ぐ。順序: run slug
  // 決定 → target 安全検証 → source 検証 → snapshot 作成 → manifest 保存
  // → RunMetaManager 作成 → logs/engine 初期化。source が取得不能な場合だけは
  // fix 側の選択的な best-effort 継承へ委ね、target の不整合や公開競合は
  // ここで失敗させる。
  const {
    sourceRunSlug,
    publishedResumeSource,
    operationClaimToken,
    operationJournalRunSlug,
    sourceOperationClaimTokens,
  } = resumeLineage;
  const operationJournalPaths = buildRunPaths(cwd, operationJournalRunSlug);
  const operationJournal: WorkflowOperationJournalContext = {
    store: createOperationJournalStore(operationJournalPaths.operationJournalAbs),
    journalRunSlug: operationJournalRunSlug,
    claimToken: operationClaimToken,
    ...(sourceOperationClaimTokens === undefined
      ? {}
      : { sourceClaimTokens: sourceOperationClaimTokens }),
  };
  let resumeArtifactsManifest: ReturnType<typeof inheritResumeReportSnapshot> | undefined;
  if (sourceRunSlug && sourceRunSlug !== runSlug) {
    try {
      resumeArtifactsManifest = inheritResumeReportSnapshot({
        cwd,
        sourceRunSlug,
        targetRunSlug: runSlug,
      });
    } catch (error) {
      if (!(error instanceof ResumeReportSnapshotSourceError)) {
        throw error;
      }
      log.warn('Resume report snapshot source unavailable; continuing without inherited snapshot', {
        sourceRunSlug,
        targetRunSlug: runSlug,
        reason: getErrorMessage(error),
        fallbackUsed: true,
      });
    }
  }
  if (resumeArtifactsManifest) {
    log.debug('Inherited resume report snapshot', {
      sourceRunSlug: resumeArtifactsManifest.sourceRunSlug,
      targetRunSlug: resumeArtifactsManifest.targetRunSlug,
      files: resumeArtifactsManifest.files.length,
    });
  }
  const sessionLog = createSessionLog(
    task,
    projectCwd,
    workflowConfig.name,
    { startTime: runBootstrap.startedAt },
  );
  const globalConfig = resolveWorkflowConfigValues(projectCwd, [
    'notificationSound',
    'notificationSoundEvents',
    'rateLimitFallback',
    'runtime',
    'preventSleep',
    'logging',
    'analytics',
    'telemetry',
    'observability',
    'autoRouting',
    'findingContract',
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
  const runMetaManager = runBootstrap.publishRunMeta({
    runPaths,
    task,
    workflowName: workflowConfig.name,
    ...(publishedResumeSource === undefined
      ? {}
      : { resumeSource: publishedResumeSource }),
    options: {
      ...(traceDiscovery ? { traceDiscovery } : {}),
      // manifest（ファイル一覧と hash の SSOT）への参照のみを meta.json に残す。
      // manifest は reports スナップショットの内側の予約名（公開を単一 rename に
      // 集約するため）。
      ...(resumeArtifactsManifest
        ? { resumeArtifactsRel: `${runPaths.reportsRel}/${RESUME_ARTIFACTS_FILE_NAME}` }
        : {}),
      operationJournalRunSlug,
      operationClaimToken,
      ...(options.prContext ? { prContext: options.prContext } : {}),
    },
  });
  const workflowSessionId = runBootstrap.sessionId;
  const ndjsonLogPath = initNdjsonLog(
    workflowSessionId,
    task,
    workflowConfig.name,
    {
      logsDir: runPaths.logsAbs,
      startTime: runBootstrap.startedAt,
    },
  );
  const sessionLogger = new SessionLogger(ndjsonLogPath, allowSensitiveData);
  if (options.interactiveMetadata) {
    sessionLogger.writeInteractiveMetadata(options.interactiveMetadata);
  }

  const shouldNotify = outputMode === 'terminal' && globalConfig.notificationSound !== false;
  const shouldNotifyIterationLimit = shouldNotify && globalConfig.notificationSoundEvents?.iterationLimit !== false;
  const shouldNotifyRateLimit = shouldNotify;
  const shouldNotifyWorkflowComplete = shouldNotify && globalConfig.notificationSoundEvents?.workflowComplete !== false;
  const shouldNotifyWorkflowAbort = shouldNotify && globalConfig.notificationSoundEvents?.workflowAbort !== false;
  const resolvedProvider = options.provider !== undefined
    ? {
        value: options.provider,
        source: options.providerSource ?? 'cli' as ProviderResolutionSource,
      }
    : resolveConfigValueWithSource(projectCwd, 'provider', {
        workflowContext: { provider: workflowConfig.provider },
      });
  const resolvedModel = options.model !== undefined
    ? {
        value: options.model,
        source: options.modelSource ?? 'cli' as ProviderResolutionSource,
      }
    : resolveConfigValueWithSource(projectCwd, 'model', {
        workflowContext: { model: workflowConfig.model },
      });
  const inheritedAutoRouting = resolveEffectiveAutoRouting(workflowConfig, globalConfig.autoRouting);

  // Configuration-format anti-corruption boundary (issue #1136): compile either legacy
  // config or an active runtime.yaml provider section into the shared engine-options bundle.
  // In legacy mode this passes the resolved legacy values through unchanged.
  const legacyProviderEnvironment: LegacyProviderEnvironmentInput = {
    provider: resolvedProvider.value,
    providerSource: resolvedProvider.source,
    model: resolvedModel.value,
    modelSource: resolvedModel.source,
    personaProviders: options.personaProviders,
    providerRouting: options.providerRouting,
    autoRouting: inheritedAutoRouting,
    providerOptions: options.providerOptions,
    taktProviders: selectConfigTaktProviders(
      loadProjectConfig(projectCwd).taktProviders,
      loadGlobalConfig().taktProviders,
    ),
  };
  const providerEnvironment = resolveCompiledProviderEnvironment({
    projectCwd,
    legacy: legacyProviderEnvironment,
    legacySignals: collectLegacyProviderSignals(
      legacyProviderEnvironment,
      {
        name: workflowConfig.name,
        provider: workflowConfig.provider,
        model: workflowConfig.model,
        autoRouting: workflowConfig.autoRouting,
      },
      options.providerOptionsSource,
    ),
  });
  const currentProvider = providerEnvironment.provider;
  const currentProviderSource = providerEnvironment.providerSource;
  const configuredModel = providerEnvironment.model;
  const configuredModelSource = providerEnvironment.modelSource;
  const effectivePersonaProviders = providerEnvironment.personaProviders;
  const effectiveProviderRouting = providerEnvironment.providerRouting;
  const effectiveProviderOptions = providerEnvironment.providerOptions;
  const providerRoutingTagConflictPolicy = providerEnvironment.tagConflictPolicy;
  const autoRoutingReachTracker = new AutoRoutingReachTracker();
  const onEffectiveAutoRoutingReached = (): void => {
    autoRoutingReachTracker.markReached();
  };
  const warnIfAutoStrategyUnused = (): void => {
    if (options.autoStrategy !== undefined && !autoRoutingReachTracker.hasReached()) {
      log.warn('--auto-strategy was ignored because execution did not reach a workflow with effective auto_routing');
    }
  };
  const autoStrategyOverride = options.autoStrategy;
  const effectiveWorkflowConfig: WorkflowConfig = {
    ...workflowConfig,
    autoRouting: providerEnvironment.autoRouting,
    rateLimitFallback: workflowConfig.rateLimitFallback ?? globalConfig.rateLimitFallback,
    runtime: resolveRuntimeConfig(globalConfig.runtime, workflowConfig.runtime),
    maxSteps: effectiveMaxSteps,
  };
  inheritWorkflowConfigMetadata(workflowConfig, effectiveWorkflowConfig);
  const providerEventLogger = createProviderEventLogger({
    logsDir: runPaths.logsAbs,
    sessionId: workflowSessionId,
    runId: runSlug,
    enabled: isProviderEventsEnabled(globalConfig),
  });
  const usageEventLogger = createUsageEventLogger({
    logsDir: runPaths.logsAbs,
    sessionId: workflowSessionId,
    runId: runSlug,
    enabled: isUsageEventsEnabled(globalConfig),
  });

  const analyticsWriterOptions = globalConfig.telemetry?.routingDecisions === true
    ? { routingEventsDir: join(projectCwd, '.takt', 'events') }
    : undefined;
  initAnalyticsWriter(
    globalConfig.analytics?.enabled === true,
    globalConfig.analytics?.eventsPath ?? join(getGlobalConfigDir(), 'analytics', 'events'),
    analyticsWriterOptions,
  );
  if (globalConfig.preventSleep) {
    preventSleep();
  }

  const analyticsEmitter = new AnalyticsEmitter(
    runSlug,
    interactiveUserInput,
    workflowSessionId,
  );
  const structuredCaller = new CapabilityAwareStructuredCaller();
  const savedSessions = shouldLoadSavedSessions
    ? (isWorktree
      ? loadWorktreeSessions(projectCwd, cwd, currentProvider)
      : loadPersonaSessions(projectCwd, currentProvider))
    : {};
  const sessionUpdateHandler = isWorktree
    ? (personaName: string, personaSessionId: string | undefined) =>
        updateWorktreeSession(projectCwd, cwd, personaName, personaSessionId, currentProvider)
    : (persona: string, personaSessionId: string | undefined) =>
        updatePersonaSession(projectCwd, persona, personaSessionId, currentProvider);
  const promptLogPath = getDebugPromptsLogFile() ?? undefined;
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
                shadowLogPath: join(
                  runPaths.logsAbs,
                  `${workflowSessionId}${OTEL_SESSION_SHADOW_LOG_FILE_SUFFIX}`,
                ),
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
    shouldNotifyRateLimit,
    shouldNotifyWorkflowComplete,
    shouldNotifyWorkflowAbort,
    currentProvider,
    currentProviderSource,
    configuredModel,
    configuredModelSource,
    personaProviders: effectivePersonaProviders,
    providerRouting: effectiveProviderRouting,
    providerRoutingTagConflictPolicy,
    providerOptions: effectiveProviderOptions,
    effectiveWorkflowConfig,
    findingContractConfig: globalConfig.findingContract,
    autoStrategyOverride,
    onEffectiveAutoRoutingReached,
    warnIfAutoStrategyUnused,
    providerEventLogger,
    usageEventLogger,
    observability: globalConfig.observability,
    observabilityHandle,
    analyticsEmitter,
    structuredCaller,
    savedSessions,
    sessionUpdateHandler,
    traceReportMode,
    ...(promptLogPath === undefined ? {} : { promptLogPath }),
    operationJournal,
  };
}

export { detectStepType, isQuietMode };
