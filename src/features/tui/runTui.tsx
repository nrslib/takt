import { render, type Instance } from 'ink';
import type { ReactElement } from 'react';
import { getWorkflowDescription, loadPersonaSessions } from '../../infra/config/index.js';
import { resolvePersonaSessionId } from '../../infra/config/project/sessionStore.js';
import { INTERACTIVE_MODES, type InteractiveMode } from '../../core/models/index.js';
import type { ProviderType } from '../../infra/providers/index.js';
import { getLabel, getLabelObject } from '../../shared/i18n/index.js';
import { info } from '../../shared/ui/index.js';
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
  type SummaryActionValue,
} from '../interactive/interactive-summary.js';
import type { TaskHistorySummaryItem } from '../interactive/interactive-summary-types.js';
import { selectInteractiveMode } from '../interactive/modeSelection.js';
import { selectRecentSession } from '../interactive/sessionSelector.js';
import type { InteractiveModeResult, InteractiveUIText } from '../interactive/interactive.js';
import { ConversationView, type ConversationExit } from './ConversationView.js';
import { PassthroughView } from './PassthroughView.js';
import { KITTY_KEYBOARD_DISABLE, KITTY_KEYBOARD_ENABLE } from './keyProtocol.js';
import { takeTerminalOwnership } from './terminalOwnership.js';
import type { TranscriptEntry } from './TranscriptEntryView.js';
import { createTuiConversation } from './tuiConversation.js';
import { describeSessionModel } from './tuiSetup.js';
import type { TuiChatSetup, TuiPassthroughSetup } from './tuiSetup.js';

/**
 * Surfaces the first failure. A teardown that also failed rides along as the
 * cause so it stays observable without hiding what actually went wrong.
 */
function buildRunFailure(
  primaryError: unknown,
  hasPrimaryError: boolean,
  reportedTeardownErrors: readonly unknown[],
): unknown {
  // The same rejection can be seen twice — once as the mount's failure and again
  // while awaiting the exit during teardown — and hanging an error off itself as
  // its own cause makes an endless chain.
  const teardownErrors = reportedTeardownErrors.filter((error) => error !== primaryError);
  const [firstTeardownError, ...restTeardownErrors] = teardownErrors;
  if (!hasPrimaryError) {
    return firstTeardownError;
  }
  if (teardownErrors.length === 0) {
    return primaryError;
  }
  return primaryError instanceof Error
    ? Object.assign(primaryError, {
      cause: restTeardownErrors.length === 0
        ? firstTeardownError
        : new AggregateError(teardownErrors, 'TUI teardown failed'),
    })
    : new AggregateError([primaryError, ...teardownErrors], 'TUI run failed');
}

/**
 * Mounts one Ink tree, waits for it to settle, and gives the terminal back.
 *
 * The selectors this run puts on screen are the ordinary readline ones, and
 * they need the terminal to themselves, so a run mounts and unmounts Ink around
 * each of them instead of keeping one tree up for the whole session. Ownership,
 * the keyboard protocol and the tree itself are therefore taken and returned
 * inside this one call, which is what keeps the pairs matched.
 */
async function mountInk<T>(
  buildTree: (handlers: {
    settle: (value: T) => void;
    /** Ends the mount with a failure, which outranks any teardown failure. */
    fail: (error: unknown) => void;
  }) => ReactElement,
  exitedEarlyMessage: string,
): Promise<T> {
  let settle!: (value: T) => void;
  let fail!: (error: unknown) => void;
  const settled = new Promise<T>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });

  // Whatever went wrong first is what the caller needs to see; a teardown that
  // also fails must never replace it, but must not vanish either.
  let primaryError: unknown;
  let hasPrimaryError = false;
  const teardownErrors: unknown[] = [];
  const recordFailure = (error: unknown): void => {
    if (hasPrimaryError) {
      teardownErrors.push(error);
      return;
    }
    hasPrimaryError = true;
    primaryError = error;
  };
  /** Runs a teardown step to completion, keeping its failure without letting it stop the rest. */
  const teardown = async (step: () => void | Promise<void>): Promise<void> => {
    try {
      await step();
    } catch (error) {
      recordFailure(error);
    }
  };

  const terminal = takeTerminalOwnership();
  let outcome: { readonly value: T } | undefined;
  try {
    let instance: Instance | undefined;
    try {
      // Enabled inside the guaranteed range so the matching disable always runs,
      // even if this very write throws. Without the protocol a terminal sends a
      // bare CR for Shift+Enter, and for Option+Enter too under iTerm2's default
      // Option=Normal, so neither can be told apart from Enter. Ink decodes the
      // CSI-u reports the flag turns on but only negotiates the mode through an
      // option that delivers every keystroke twice, so it is driven here exactly
      // as the readline editor drives it.
      terminal.stdout.write(KITTY_KEYBOARD_ENABLE);
      instance = render(buildTree({ settle, fail }), {
        exitOnCtrlC: false,
        stdout: terminal.stdout,
        stderr: terminal.stderr,
      });

      // An Ink teardown before the view settles would leave this pending.
      instance.waitUntilExit().then(
        () => fail(new Error(exitedEarlyMessage)),
        (error: unknown) => fail(error),
      );

      outcome = { value: await settled };
    } catch (error) {
      recordFailure(error);
    } finally {
      // Each step is guaranteed on its own: a failure in one must not skip the next.
      const mounted = instance;
      if (mounted) {
        // The dynamic frame is erased first: what follows this mount is either a
        // readline selector or the end of the run, and neither should be drawn
        // under a leftover input box.
        await teardown(() => mounted.clear());
        await teardown(() => mounted.unmount());
        await teardown(async () => {
          await mounted.waitUntilExit();
        });
      }
      await teardown(() => {
        terminal.stdout.write(KITTY_KEYBOARD_DISABLE);
      });
      await teardown(() => {
        // Ink unrefs stdin when it hands raw mode back, which leaves the next
        // reader polling a handle libuv has stopped watching: measured on a real
        // PTY, the readline selector that runs after a mount never receives a
        // keypress without this.
        if (process.stdin.isTTY) {
          process.stdin.ref();
        }
      });
    }
  } catch (error) {
    recordFailure(error);
  } finally {
    await teardown(() => terminal.release());
  }

  if (outcome === undefined || hasPrimaryError || teardownErrors.length > 0) {
    throw buildRunFailure(primaryError, hasPrimaryError, teardownErrors);
  }
  return outcome.value;
}

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
}

/**
 * Hands the pasted images to the caller together with the safety net.
 *
 * The run is over, but the files are not: the caller still puts them through a
 * label selector and a workflow, and those can end the process on Ctrl+C. The
 * net therefore stays armed until the caller's own attachment cleanup runs,
 * which is the moment the files stop being needed. With nothing pasted there is
 * no cleanup to wait for, so the net comes down straight away.
 */
function handOverAttachments(
  result: InteractiveModeResult,
  releaseExitCleanup: () => void,
): InteractiveModeResult {
  const cleanupAttachments = result.cleanupAttachments;
  if (cleanupAttachments === undefined) {
    releaseExitCleanup();
    return result;
  }
  let released = false;
  return {
    ...result,
    cleanupAttachments: () => {
      try {
        cleanupAttachments();
      } finally {
        // A caller that cleans up twice must not take the net down twice.
        if (!released) {
          released = true;
          releaseExitCleanup();
        }
      }
    },
  };
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
  const attachmentStore = createSessionImageAttachmentStore();
  // The selectors this run opens end the process themselves when interrupted,
  // taking every `finally` below with them, so the temp files get a net that
  // does not depend on this function finishing.
  const releaseExitCleanup = cleanupImageAttachmentStoreOnProcessExit(attachmentStore);
  /** Set once the caller owns the files and the net that outlives this call. */
  let handedOver = false;
  const exitedEarly = getLabel('tui.errors.exitedEarly', options.lang);
  const summaryUi = getLabelObject<InteractiveUIText>('interactive.ui', options.lang);
  const chooseAction = createPostSummaryActionSelector(
    summaryUi.proposed,
    summaryUi,
    options.excludeActions ?? [],
  );

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
    const { provider } = resolveAssistantProviderModel(options.cwd, {
      ...(options.agentOverrides?.provider ? { provider: options.agentOverrides.provider as ProviderType } : {}),
      ...(options.agentOverrides?.model ? { model: options.agentOverrides.model } : {}),
    });
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
  function prepareMode(
    mode: InteractiveMode,
    description: WorkflowSummary,
  ): TuiChatSetup | TuiPassthroughSetup {
    try {
      return buildModeSetup(mode, description);
    } catch (error) {
      if (error instanceof ProviderNotConfiguredError) {
        throw new Error(getLabel('tui.errors.providerNotConfigured', options.lang));
      }
      throw error;
    }
  }

  function buildModeSetup(
    mode: InteractiveMode,
    description: WorkflowSummary,
  ): TuiChatSetup | TuiPassthroughSetup {
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
    const plan: ConversationPlan = mode === 'persona' && description.firstStep !== undefined
      ? createPersonaConversationPlan(options.cwd, description.firstStep)
      : createAssistantConversationPlan(options.cwd, {
        assistantMode: mode === 'grill-me' ? 'grill-me' : 'assistant',
        workflowContext,
        ...(options.agentOverrides?.provider ? { provider: options.agentOverrides.provider as ProviderType } : {}),
        ...(options.agentOverrides?.model ? { model: options.agentOverrides.model } : {}),
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
   * The conversation, mounted once per stretch between selectors. Everything the
   * next mount has to continue from — the session, the recall history — is held
   * here; the transcript itself is already in the scrollback, so a remount seeds
   * an empty one rather than printing it a second time.
   */
  async function runConversation(setup: TuiChatSetup): Promise<InteractiveModeResult> {
    let initialEntries: readonly TranscriptEntry[] = setup.initialEntries;
    let autoSubmit = setup.autoSubmit;
    let history: readonly string[] = [];

    while (true) {
      const settled = await mountInk<{
        readonly exit: Exclude<ConversationExit, { kind: 'failed' }>;
        readonly history: readonly string[];
      }>(({ settle, fail }) => (
        <ConversationView
          ui={{
            thinking: getLabel('tui.ui.thinking', options.lang),
            hint: getLabel('tui.ui.hint', options.lang),
            placeholder: getLabel('tui.ui.placeholder', options.lang),
            queuedHint: getLabel('tui.ui.queuedHint', options.lang),
            queuedMore: getLabel('tui.ui.queuedMore', options.lang),
          }}
          lang={options.lang}
          conversation={setup.conversation}
          initialEntries={initialEntries}
          submitMode={setup.kind}
          autoSubmit={autoSubmit}
          initialHistory={history}
          modelLabel={setup.modelLabel}
          onExit={(exit, nextHistory) => {
            // A failure ends the run rather than the mount, so it is reported as
            // the mount's own failure and outranks anything the teardown hits.
            if (exit.kind === 'failed') {
              fail(exit.error);
              return;
            }
            settle({ exit, history: nextHistory });
          }}
        />
      ), exitedEarly);

      history = settled.history;
      initialEntries = [];
      autoSubmit = false;

      switch (settled.exit.kind) {
        case 'result':
          return settled.exit.result;
        case 'choose_action': {
          const action = await chooseAction(settled.exit.task);
          if (action === null || action === 'continue') {
            info(summaryUi.continuePrompt);
            break;
          }
          return { action, task: settled.exit.task };
        }
        case 'resume_session': {
          const selected = await selectRecentSession(options.cwd, options.lang);
          if (selected !== null) {
            setup.conversation.resumeSession(selected);
            info(getLabel('interactive.resumeSessionLoaded', options.lang));
          }
          break;
        }
      }
    }
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

    const setup = prepareMode(mode, description);
    const result = setup.kind === 'passthrough'
      ? await runPassthrough(setup)
      : await runConversation(setup);
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
