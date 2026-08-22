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
import { displayAndClearSessionState } from '../interactive/conversationLoop.js';
import {
  buildInteractiveResultWithAttachments,
  cleanupImageAttachmentStore,
  cleanupImageAttachmentStoreOnProcessExit,
  createClipboardImagePasteHandler,
  createImagePasteHandler,
  createSessionImageAttachmentStore,
} from '../interactive/imageAttachments.js';
import {
  createPostSummaryActionSelector,
  type PostSummaryAction,
  type SummaryActionValue,
} from '../interactive/interactive-summary.js';
import type { TaskHistorySummaryItem } from '../interactive/interactive-summary-types.js';
import { selectInteractiveMode } from '../interactive/modeSelection.js';
import { formatSessionStatus } from '../interactive/interactive.js';
import type { InteractiveModeResult, InteractiveUIText } from '../interactive/interactive.js';
import { runTuiConversation } from './conversationRunner.js';
import { PassthroughView } from './PassthroughView.js';
import { handOverAttachments } from './attachmentHandover.js';
import { mountInk } from './inkMount.js';
import type { TranscriptEntry } from './TranscriptEntryView.js';
import { createTuiConversation } from './tuiConversation.js';
import { describeSessionModel } from './tuiSetup.js';
import type { TuiChatSetup, TuiPassthroughSetup } from './tuiSetup.js';
import { resolveFormalSpecMode } from '../interactive/taskInstructionFormat.js';

/** What the mode setup needs from the chosen workflow. */
type WorkflowSummary = ReturnType<typeof getWorkflowDescription>;

export interface RunTuiOptions {
  cwd: string;
  lang: 'en' | 'ja';
  /** Workflow named on the command line; when absent the workflow selector runs. */
  workflowId?: string;
  /** How many steps of the workflow to describe to the assistant. */
  previewCount: number | undefined;
  agentOverrides?: TaskExecutionOptions;
  taskHistory: TaskHistorySummaryItem[];
  /** Task text supplied on the command line. */
  userMessage?: string;
  /** Untrusted reference context loaded from PR/Issue sources. */
  sourceContext?: string;
  /** Actions withheld from the post-summary selector. */
  excludeActions?: readonly SummaryActionValue[];
  /** `--continue`: resume the last assistant session for the chosen mode. */
  continueSession?: boolean;
  /**
   * Runs what the conversation decided on, with Ink unmounted, and comes back.
   *
   * With it the session stays resident: the task runs, its result is written
   * into the transcript, and the same conversation takes the next request.
   * Without it the run ends at the first decision, which is what a caller that
   * only wants one task relies on.
   */
  dispatch?: (workflowId: string, result: InteractiveModeResult) => Promise<void>;
}

export type TuiRunResult =
  /** Ended before a workflow and mode were chosen; there is nothing to dispatch. */
  | { kind: 'cancelled' }
  | { kind: 'selected'; workflowId: string; result: InteractiveModeResult };

function resolveAvailableModes(options: RunTuiOptions): readonly InteractiveMode[] {
  // Passthrough would drop the fetched PR/Issue context, so it is withheld then.
  return options.sourceContext && !options.userMessage
    ? INTERACTIVE_MODES.filter((mode) => mode !== 'passthrough')
    : INTERACTIVE_MODES;
}

/**
 * Runs a task conversation in the Ink TUI.
 *
 * Choosing a workflow and a mode, picking a post-summary action and picking a
 * session to resume are all done by the ordinary readline selectors, before Ink
 * mounts and between mounts. Ink owns nothing but the conversation itself.
 */
export async function runTui(options: RunTuiOptions): Promise<TuiRunResult> {
  const attachmentStore = createSessionImageAttachmentStore(options.cwd);
  // The selectors this run opens end the process themselves when interrupted,
  // taking every `finally` below with them, so the temp files get a net that
  // does not depend on this function finishing.
  const releaseExitCleanup = cleanupImageAttachmentStoreOnProcessExit(attachmentStore);
  /** Set once the caller owns the files and the net that outlives this call. */
  let handedOver = false;
  const exitedEarly = getLabel('tui.errors.exitedEarly', options.lang);
  const summaryUi = getLabelObject<InteractiveUIText>('interactive.ui', options.lang);
  const selectAction = createPostSummaryActionSelector(
    summaryUi.proposed,
    summaryUi,
    options.excludeActions ?? [],
  );
  /** The generic conversation has no draft to normalize; the task is the task. */
  const chooseAction = async (
    task: string,
  ): Promise<{ action: PostSummaryAction; task: string } | null> => {
    const action = await selectAction(task);
    return action === null ? null : { action, task };
  };

  function buildInitialEntries(
    intro: string,
    personaFallback: boolean,
    resumeNotice: string | null,
  ): TranscriptEntry[] {
    const entries: TranscriptEntry[] = [{ role: 'system', content: intro }];
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

  /**
   * The provider and model the caller named on the command line, in the shape
   * the assistant ladder takes them. Built in one place so the session it
   * resumes and the plan it then runs cannot resolve different providers.
   */
  function agentProviderOverrides(): { provider?: ProviderType; model?: string } {
    return {
      ...(options.agentOverrides?.provider
        ? { provider: options.agentOverrides.provider as ProviderType }
        : {}),
      ...(options.agentOverrides?.model ? { model: options.agentOverrides.model } : {}),
    };
  }

  /**
   * `--continue` resumes the session recorded for the mode's own persona. The
   * notice mirrors the readline flow, which says either that it is resuming or
   * that nothing was found to resume from.
   */
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

  /**
   * Single boundary for setup failures: everything below throws domain errors and
   * this turns the ones a user can act on into localized messages.
   */
  async function prepareMode(
    mode: InteractiveMode,
    description: WorkflowSummary,
  ): Promise<TuiChatSetup | TuiPassthroughSetup> {
    try {
      return await buildModeSetup(mode, description);
    } catch (error) {
      if (error instanceof ProviderNotConfiguredError) {
        throw new Error(getLabel('tui.errors.providerNotConfigured', options.lang));
      }
      throw error;
    }
  }

  async function buildModeSetup(
    mode: InteractiveMode,
    description: WorkflowSummary,
  ): Promise<TuiChatSetup | TuiPassthroughSetup> {
    if (mode === 'passthrough') {
      return {
        kind: 'passthrough',
        intro: getLabel('interactive.ui.introPassthrough', options.lang),
        seedText: options.userMessage ?? '',
        images: {
          pasteClipboardImage: (abortSignal) =>
            createClipboardImagePasteHandler(attachmentStore)(abortSignal),
          saveInlineImage: (image) => createImagePasteHandler(attachmentStore)(image),
          sealImages: () => attachmentStore.seal(),
        },
      };
    }

    const workflowContext = {
      name: description.name,
      description: description.description,
      workflowStructure: description.workflowStructure,
      stepPreviews: description.stepPreviews,
      taskHistory: options.taskHistory,
    };
    const personaFallback = mode === 'persona' && description.firstStep === undefined;
    const continued = resolveContinuedSession(mode);
    const usePersonaPlan = mode === 'persona' && description.firstStep !== undefined;
    const formalSpec = usePersonaPlan ? false : await resolveFormalSpecMode(options.cwd);
    const plan: ConversationPlan = usePersonaPlan
      ? createPersonaConversationPlan(options.cwd, description.firstStep!)
      : createAssistantConversationPlan(options.cwd, {
        assistantMode: mode === 'grill-me' ? 'grill-me' : 'assistant',
        formalSpec,
        workflowContext,
        ...agentProviderOverrides(),
        ...(continued.sessionId ? { sessionId: continued.sessionId } : {}),
      });
    const hasSeededInput = options.userMessage !== undefined || options.sourceContext !== undefined;

    return {
      kind: mode === 'quiet' ? 'summarize' : 'chat',
      modelLabel: getLabel('tui.ui.model', options.lang, { value: describeSessionModel(plan.ctx) }),
      conversation: createTuiConversation({
        cwd: options.cwd,
        plan,
        workflowContext,
        attachmentStore,
        ...(options.userMessage ? { userMessage: options.userMessage } : {}),
        ...(options.sourceContext ? { sourceContext: options.sourceContext } : {}),
      }),
      // Quiet with a seed summarizes at once, exactly like the readline mode.
      autoSubmit: mode === 'quiet' && hasSeededInput,
      initialEntries: buildInitialEntries(
        mode === 'quiet'
          ? getLabel('interactive.ui.introQuiet', options.lang)
          : plan.strategy.introMessage,
        personaFallback,
        continued.notice,
      ),
    };
  }

  function runPassthrough(setup: TuiPassthroughSetup): Promise<InteractiveModeResult> {
    return mountInk<InteractiveModeResult>(({ settle }) => (
      <PassthroughView
        intro={setup.intro}
        hint={getLabel('tui.ui.passthroughHint', options.lang)}
        placeholder={getLabel('tui.ui.placeholder', options.lang)}
        lang={options.lang}
        images={setup.images}
        initialText={setup.seedText}
        onDone={settle}
      />
    ), exitedEarly);
  }

  /**
   * What a finished task leaves behind, as one transcript line. The run writes
   * its own state file, which is the same source the readline flow reads when it
   * greets the next session — so the wording matches what users already know.
   */
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

  function runConversation(setup: TuiChatSetup, workflowId: string): Promise<InteractiveModeResult> {
    return runTuiConversation({
      cwd: options.cwd,
      lang: options.lang,
      conversation: setup.conversation,
      initialEntries: setup.initialEntries,
      submitMode: setup.kind,
      autoSubmit: setup.autoSubmit,
      modelLabel: () => setup.modelLabel,
      chooseAction,
      continuePrompt: summaryUi.continuePrompt,
      ...(options.dispatch === undefined ? {} : { dispatch: dispatchDecision(workflowId) }),
    });
  }

  /**
   * Hands the decision to the caller with the images it referenced, then turns
   * what the run recorded about itself into the line that greets the session.
   */
  function dispatchDecision(
    workflowId: string,
  ): (result: InteractiveModeResult) => Promise<string | null> {
    return async (result) => {
      const dispatch = options.dispatch;
      if (dispatch === undefined) {
        return null;
      }
      const attachments = attachmentStore.listAttachments();
      await dispatch(workflowId, {
        ...result,
        ...(attachments.length > 0 ? { attachments } : {}),
      });
      return describeDispatchOutcome(result.action);
    };
  }

  try {
    // Both selectors are the readline ones the non-TUI flow uses, run on the bare
    // terminal before Ink takes it over.
    const workflowId = await determineWorkflow(options.cwd, options.workflowId);
    if (workflowId === null) {
      cleanupImageAttachmentStore(attachmentStore);
      return { kind: 'cancelled' };
    }
    const description = getWorkflowDescription(
      workflowId,
      options.cwd,
      options.previewCount,
      options.cwd,
      options.agentOverrides,
    );
    const mode = await selectInteractiveMode(
      options.lang,
      description.interactiveMode,
      resolveAvailableModes(options),
    );
    if (mode === null) {
      cleanupImageAttachmentStore(attachmentStore);
      return { kind: 'cancelled' };
    }

    // Printed where the readline conversation prints it: after the mode is
    // chosen, before the conversation starts.
    displayAndClearSessionState(options.cwd, options.lang);

    const setup = await prepareMode(mode, description);
    const result = setup.kind === 'passthrough'
      ? await runPassthrough(setup)
      : await runConversation(setup, workflowId);
    const handedOverResult = handOverAttachments(
      buildInteractiveResultWithAttachments(result, attachmentStore),
      releaseExitCleanup,
    );
    handedOver = true;
    return { kind: 'selected', workflowId, result: handedOverResult };
  } catch (error) {
    // Nothing was handed to the caller, so nothing is left to clean the pasted
    // images up but this.
    cleanupImageAttachmentStore(attachmentStore);
    throw error;
  } finally {
    // Only the paths that keep the files take the net down themselves; every
    // other one ends here with nothing left to protect.
    if (!handedOver) {
      releaseExitCleanup();
    }
  }
}
