import {
  getWorkflowDescription,
  loadPersonaSessions,
  takeSessionState,
} from '../../infra/config/index.js';
import { resolvePersonaSessionId } from '../../infra/config/project/sessionStore.js';
import { INTERACTIVE_MODES, type InteractiveMode } from '../../core/models/index.js';
import type { ProviderType } from '../../infra/providers/index.js';
import { getLabel, getLabelObject } from '../../shared/i18n/index.js';
import { determineWorkflow } from '../tasks/index.js';
import type { TaskExecutionOptions } from '../tasks/execute/types.js';
import { getAssistantSessionPersona } from '../interactive/assistantMode.js';
import { ProviderNotConfiguredError } from '../interactive/sessionInitialization.js';
import { resolveAssistantProviderModel } from '../interactive/assistantConfig.js';
import {
  createAssistantConversationPlan,
  createPersonaConversationPlan,
  type ConversationPlan,
} from '../interactive/conversationPlan.js';
import type { ConversationMessage } from '../interactive/interactiveApplication.js';
import { displayAndClearSessionState } from '../interactive/conversationLoop.js';
import {
  buildInteractiveResultWithAttachments,
  cleanupImageAttachmentStore,
  cleanupImageAttachmentStoreOnProcessExit,
  createSessionImageAttachmentStore,
} from '../interactive/imageAttachments.js';
import {
  createPostSummaryActionSelector,
  type PostSummaryAction,
  type SummaryActionValue,
} from '../interactive/interactive-summary.js';
import type { TaskHistorySummaryItem } from '../interactive/interactive-summary-types.js';
import { selectInteractiveMode } from '../interactive/modeSelection.js';
import { selectInteractiveProvider } from '../interactive/providerSelection.js';
import { formatSessionStatus } from '../interactive/interactive.js';
import type { InteractiveModeResult, InteractiveUIText } from '../interactive/interactive.js';
import {
  resolveFormalSpecConfiguration,
  type ResolvedFormalSpecConfiguration,
} from '../interactive/taskInstructionFormat.js';
import { runTuiConversation } from './conversationRunner.js';
import { handOverAttachments } from './attachmentHandover.js';
import type { TranscriptEntry } from './TranscriptEntryView.js';
import {
  createTuiConversation,
  type TuiConversation,
  type TuiHandoffId,
  type TuiSubmitInput,
  type TuiSubmission,
} from './tuiConversation.js';
import { describeSessionModel } from './tuiSetup.js';

type WorkflowSummary = ReturnType<typeof getWorkflowDescription>;

export interface RunTuiOptions {
  cwd: string;
  lang: 'en' | 'ja';
  workflowId?: string;
  previewCount: number | undefined;
  agentOverrides?: TaskExecutionOptions;
  taskHistory: TaskHistorySummaryItem[];
  userMessage?: string;
  sourceContext?: string;
  excludeActions?: readonly SummaryActionValue[];
  continueSession?: boolean;
  dispatch?: (workflowId: string, result: InteractiveModeResult) => Promise<void>;
}

export type TuiRunResult =
  | { kind: 'cancelled' }
  | { kind: 'selected'; workflowId: string; result: InteractiveModeResult };

export async function runTui(options: RunTuiOptions): Promise<TuiRunResult> {
  const attachmentStore = createSessionImageAttachmentStore(options.cwd);
  const releaseExitCleanup = cleanupImageAttachmentStoreOnProcessExit(attachmentStore);
  let handedOver = false;
  const summaryUi = getLabelObject<InteractiveUIText>('interactive.ui', options.lang);
  const selectAction = createPostSummaryActionSelector(
    summaryUi.proposed,
    summaryUi,
    options.excludeActions ?? [],
  );
  const chooseAction = async (
    task: string,
  ): Promise<{ action: PostSummaryAction; task: string } | null> => {
    const action = await selectAction(task);
    return action === null ? null : { action, task };
  };

  function agentProviderOverrides(): { provider?: ProviderType; model?: string } {
    return {
      ...(options.agentOverrides?.provider
        ? { provider: options.agentOverrides.provider as ProviderType }
        : {}),
      ...(options.agentOverrides?.model ? { model: options.agentOverrides.model } : {}),
    };
  }

  function resolveContinuedSession(
    mode: InteractiveMode,
  ): { sessionId: string | undefined; notice: string | null } {
    if (options.continueSession !== true || (mode !== 'assistant' && mode !== 'grill-me')) {
      return { sessionId: undefined, notice: null };
    }
    const { provider } = resolveAssistantProviderModel(options.cwd, agentProviderOverrides());
    if (!provider) {
      throw new ProviderNotConfiguredError();
    }
    const saved = resolvePersonaSessionId(
      loadPersonaSessions(options.cwd, provider),
      getAssistantSessionPersona(mode),
      provider,
    );
    return saved
      ? { sessionId: saved, notice: getLabel('interactive.ui.resume', options.lang) }
      : { sessionId: undefined, notice: getLabel('interactive.continueNoSession', options.lang) };
  }

  function workflowContext(description: WorkflowSummary) {
    return {
      name: description.name,
      description: description.description,
      workflowStructure: description.workflowStructure,
      stepPreviews: description.stepPreviews,
      taskHistory: options.taskHistory,
    };
  }

  function buildInitialEntries(
    plan: ConversationPlan,
    personaFallback: boolean,
    resumeNotice: string | null,
  ): TranscriptEntry[] {
    const entries: TranscriptEntry[] = [{
      role: 'system',
      content: plan.strategy.introMessage,
    }];
    if (resumeNotice !== null) {
      entries.push({ role: 'system', content: resumeNotice });
    }
    if (personaFallback) {
      entries.push({
        role: 'system',
        content: getLabel('interactive.ui.personaFallback', options.lang),
      });
    }
    if (options.userMessage) {
      entries.push({ role: 'user', content: options.userMessage });
    }
    return entries;
  }

  function describeDispatchOutcome(action: InteractiveModeResult['action']): string {
    const state = takeSessionState(options.cwd);
    if (state) {
      return formatSessionStatus(state, options.lang);
    }
    return getLabel(action === 'save_task'
      ? 'tui.ui.taskSaved'
      : action === 'create_issue'
        ? 'tui.ui.issueCreated'
        : 'tui.ui.runFinished', options.lang);
  }

  try {
    const initialWorkflowId = await determineWorkflow(options.cwd, options.workflowId);
    if (initialWorkflowId === null) {
      cleanupImageAttachmentStore(attachmentStore);
      return { kind: 'cancelled' };
    }
    const initialMode = await selectInteractiveMode(options.lang, INTERACTIVE_MODES);
    if (initialMode === null) {
      cleanupImageAttachmentStore(attachmentStore);
      return { kind: 'cancelled' };
    }

    let selectedWorkflowId = initialWorkflowId;
    let activeWorkflowId = initialWorkflowId;
    let selectedMode = initialMode;
    const startupOverrides = agentProviderOverrides();
    let selectedProvider = startupOverrides.provider;
    let selectedModel = startupOverrides.model;
    let selectedEffort: string | undefined;
    let temporaryProviderActive = false;
    let temporaryModelActive = false;
    let formalSpecConfiguration: ResolvedFormalSpecConfiguration | undefined;
    let currentPlan: ConversationPlan;
    let currentConversation: TuiConversation;
    let pendingRebuild = false;
    let pendingHandoffHistory: readonly ConversationMessage[] | undefined;

    async function createCurrentConversation(
      initial: boolean,
      handoffHistory?: readonly ConversationMessage[],
    ): Promise<{ initialEntries: readonly TranscriptEntry[] }> {
      const workflowPreviewOverrides = startupOverrides.provider || startupOverrides.model
        ? {
            ...(startupOverrides.provider ? { provider: startupOverrides.provider } : {}),
            ...(startupOverrides.model ? { model: startupOverrides.model } : {}),
          }
        : undefined;
      const firstStepOverrides = temporaryProviderActive && selectedProvider
        ? { provider: selectedProvider }
        : undefined;
      const description = getWorkflowDescription(
        selectedWorkflowId,
        options.cwd,
        options.previewCount,
        options.cwd,
        workflowPreviewOverrides,
        firstStepOverrides,
      );
      const context = workflowContext(description);
      const personaFallback = selectedMode === 'persona' && description.firstStep === undefined;
      const usePersonaPlan = selectedMode === 'persona' && description.firstStep !== undefined;
      if (!usePersonaPlan && formalSpecConfiguration === undefined) {
        formalSpecConfiguration = await resolveFormalSpecConfiguration(options.cwd);
      }
      const continued = initial
        ? resolveContinuedSession(selectedMode)
        : { sessionId: undefined, notice: null };
      const overrides = {
        ...(selectedProvider ? { provider: selectedProvider } : {}),
        ...(selectedModel ? { model: selectedModel } : {}),
        ...(selectedEffort ? { effort: selectedEffort } : {}),
        ...(!initial && selectedProvider === undefined
          ? { resolvedSessionContext: currentPlan.ctx }
          : {}),
        ...((temporaryProviderActive || temporaryModelActive || selectedEffort !== undefined)
          ? { disableSessionRetry: true }
          : {}),
      };
      let nextPlan: ConversationPlan;
      if (usePersonaPlan) {
        nextPlan = createPersonaConversationPlan(options.cwd, description.firstStep!, overrides);
      } else {
        if (formalSpecConfiguration === undefined) {
          throw new Error('Formal specification configuration is required for assistant mode');
        }
        nextPlan = createAssistantConversationPlan(options.cwd, {
          assistantMode: selectedMode === 'grill-me' ? 'grill-me' : 'assistant',
          formalSpec: formalSpecConfiguration.mode,
          formalSpecComments: formalSpecConfiguration.comments,
          resolveResumedFormalSpecConfiguration: () => resolveFormalSpecConfiguration(options.cwd),
          workflowContext: context,
          ...overrides,
          ...(continued.sessionId ? { sessionId: continued.sessionId } : {}),
        });
      }
      const nextConversation = createTuiConversation({
        cwd: options.cwd,
        plan: nextPlan,
        workflowContext: context,
        attachmentStore,
        enableSettingsCommands: true,
        ...(initial && options.userMessage ? { userMessage: options.userMessage } : {}),
        ...(handoffHistory ? { handoffHistory } : {}),
        ...((temporaryProviderActive || temporaryModelActive)
          ? { persistSession: false }
          : {}),
        ...(options.sourceContext ? { sourceContext: options.sourceContext } : {}),
      });
      currentPlan = nextPlan;
      currentConversation = nextConversation;
      activeWorkflowId = selectedWorkflowId;
      return {
        initialEntries: initial
          ? buildInitialEntries(nextPlan, personaFallback, continued.notice)
          : [],
      };
    }

    function requestRebuild(): void {
      if (!pendingRebuild) {
        pendingHandoffHistory = currentConversation.snapshotHistory?.() ?? [];
      }
      pendingRebuild = true;
    }

    async function ensureCurrentConversation(): Promise<string | undefined> {
      if (!pendingRebuild) {
        return undefined;
      }
      const history = pendingHandoffHistory;
      try {
        await createCurrentConversation(false, history);
        return undefined;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return getLabel('tui.errors.conversationRebuildFailed', options.lang, { error: message });
      } finally {
        pendingRebuild = false;
        pendingHandoffHistory = undefined;
      }
    }

    function describeDisplayedSessionModel(): string {
      if (!pendingRebuild) {
        return describeSessionModel(currentPlan.ctx);
      }
      // Rebuild is lazy: show explicit setting overrides while the current plan remains active.
      const pendingContext = {
        ...currentPlan.ctx,
        ...(temporaryProviderActive
          && selectedProvider !== undefined
          && selectedProvider !== currentPlan.ctx.providerType
          ? {
            providerType: selectedProvider,
            // A provider-only handoff has not resolved a model yet; avoid showing the old one.
            model: undefined,
          }
          : {}),
        ...(temporaryModelActive ? { model: selectedModel } : {}),
      };
      return describeSessionModel(pendingContext);
    }

    const conversationFacade: TuiConversation = {
      get lang() {
        return currentConversation.lang;
      },
      get commandAvailability() {
        return currentConversation.commandAvailability;
      },
      get tracksResultSource() {
        return currentConversation.tracksResultSource;
      },
      isCommandLine(text: string): boolean {
        return currentConversation.isCommandLine(text);
      },
      resolveLocalCommand(text: string) {
        return currentConversation.resolveLocalCommand(text);
      },
      async submit(input: TuiSubmitInput): Promise<TuiSubmission> {
        const rebuildError = await ensureCurrentConversation();
        if (rebuildError !== undefined) {
          return { kind: 'error', message: rebuildError };
        }
        return currentConversation.submit(input);
      },
      async createInstruction(input: TuiSubmitInput): Promise<TuiSubmission> {
        const rebuildError = await ensureCurrentConversation();
        if (rebuildError !== undefined) {
          return { kind: 'error', message: rebuildError };
        }
        return currentConversation.createInstruction(input);
      },
      async resumeSession(sessionId: string): Promise<string | undefined> {
        const rebuildError = await ensureCurrentConversation();
        if (rebuildError !== undefined) {
          return rebuildError;
        }
        await currentConversation.resumeSession(sessionId);
        return undefined;
      },
      recordRejectedDraft(task: string): void {
        currentConversation.recordRejectedDraft?.(task);
      },
      snapshotHistory(): readonly ConversationMessage[] {
        return currentConversation.snapshotHistory?.() ?? [];
      },
      setEffort(effort: string): void {
        currentConversation.setEffort?.(effort);
      },
      pasteClipboardImage(abortSignal: AbortSignal): Promise<string> {
        return currentConversation.pasteClipboardImage(abortSignal);
      },
      sealImages(): void {
        currentConversation.sealImages();
      },
      saveInlineImage(image) {
        return currentConversation.saveInlineImage(image);
      },
    };

    async function handleHandoff(id: TuiHandoffId, text: string) {
      switch (id) {
        case 'workflow': {
          const workflowId = await determineWorkflow(options.cwd, undefined);
          if (workflowId !== null && workflowId !== selectedWorkflowId) {
            selectedWorkflowId = workflowId;
            requestRebuild();
          }
          break;
        }
        case 'mode': {
          const mode = await selectInteractiveMode(options.lang, INTERACTIVE_MODES);
          if (mode !== null && mode !== selectedMode) {
            selectedMode = mode;
            if (mode !== 'persona' && formalSpecConfiguration === undefined) {
              formalSpecConfiguration = await resolveFormalSpecConfiguration(options.cwd);
            }
            requestRebuild();
          }
          break;
        }
        case 'provider': {
          const currentProvider = selectedProvider ?? currentPlan.ctx.providerType;
          const provider = await selectInteractiveProvider(options.lang, currentProvider);
          if (provider !== null && provider !== currentProvider) {
            selectedProvider = provider;
            temporaryProviderActive = true;
            selectedModel = undefined;
            selectedEffort = undefined;
            temporaryModelActive = false;
            requestRebuild();
          }
          break;
        }
        case 'model':
          selectedModel = text;
          temporaryModelActive = true;
          requestRebuild();
          break;
        case 'effort':
          selectedEffort = text;
          if (pendingRebuild) {
            break;
          }
          currentConversation.setEffort?.(text);
          break;
        default:
          throw new Error(`Unknown TUI hand-off: ${id}`);
      }
      return { kind: 'continue' as const };
    }

    displayAndClearSessionState(options.cwd, options.lang);
    const setup = await createCurrentConversation(true);
    const dispatch = options.dispatch;
    const result = await runTuiConversation({
      cwd: options.cwd,
      lang: options.lang,
      conversation: conversationFacade,
      initialEntries: setup.initialEntries,
      submitMode: 'chat',
      autoSubmit: false,
      modelLabel: () => getLabel('tui.ui.model', options.lang, {
        value: describeDisplayedSessionModel(),
      }),
      chooseAction,
      continuePrompt: summaryUi.continuePrompt,
      onHandoff: handleHandoff,
      ...(dispatch === undefined
        ? {}
        : {
          dispatch: async (result) => {
            const rebuildError = await ensureCurrentConversation();
            if (rebuildError !== undefined) {
              return rebuildError;
            }
            const attachments = attachmentStore.listAttachments();
            await dispatch(activeWorkflowId, {
              ...result,
              ...(attachments.length > 0 ? { attachments } : {}),
            });
            return describeDispatchOutcome(result.action);
          },
        }),
    });
    const handedOverResult = handOverAttachments(
      buildInteractiveResultWithAttachments(result, attachmentStore),
      releaseExitCleanup,
    );
    handedOver = true;
    return { kind: 'selected', workflowId: activeWorkflowId, result: handedOverResult };
  } catch (error) {
    cleanupImageAttachmentStore(attachmentStore);
    if (error instanceof ProviderNotConfiguredError) {
      throw new Error(getLabel('tui.errors.providerNotConfigured', options.lang));
    }
    throw error;
  } finally {
    if (!handedOver) {
      releaseExitCleanup();
    }
  }
}
