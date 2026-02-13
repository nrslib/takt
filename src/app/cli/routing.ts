/**
 * Default action routing
 *
 * Handles the default (no subcommand) action: task execution,
 * pipeline mode, or interactive mode.
 */

import { info, error, withProgress } from '../../shared/ui/index.js';
import { confirm } from '../../shared/prompt/index.js';
import { getErrorMessage } from '../../shared/utils/index.js';
import { getLabel } from '../../shared/i18n/index.js';
import { fetchIssue, formatIssueAsTask, checkGhCli, parseIssueNumbers, type GitHubIssue } from '../../infra/github/index.js';
import { selectAndExecuteTask, determinePiece, saveTaskFromInteractive, createIssueFromTask, type SelectAndExecuteOptions } from '../../features/tasks/index.js';
import { executePipeline } from '../../features/pipeline/index.js';
import {
  interactiveMode,
  selectInteractiveMode,
  selectRecentSession,
  passthroughMode,
  quietMode,
  personaMode,
  resolveLanguage,
  type InteractiveModeResult,
} from '../../features/interactive/index.js';
import { dispatchConversationAction } from '../../features/interactive/actionDispatcher.js';
import { getPieceDescription, loadGlobalConfig } from '../../infra/config/index.js';
import { DEFAULT_PIECE_NAME } from '../../shared/constants.js';
import { program, resolvedCwd, pipelineMode } from './program.js';
import { resolveAgentOverrides, parseCreateWorktreeOption, isDirectTask } from './helpers.js';

/**
 * Resolve issue references from CLI input.
 *
 * Handles two sources:
 * - --issue N option (numeric issue number)
 * - Positional argument containing issue references (#N or "#1 #2")
 *
 * Returns resolved issues and the formatted task text for interactive mode.
 * Throws on gh CLI unavailability or fetch failure.
 */
async function resolveIssueInput(
  issueOption: number | undefined,
  task: string | undefined,
): Promise<{ issues: GitHubIssue[]; initialInput: string } | null> {
  if (issueOption) {
    const ghStatus = checkGhCli();
    if (!ghStatus.available) {
      throw new Error(ghStatus.error);
    }
    const issue = await withProgress(
      'Fetching GitHub Issue...',
      (fetchedIssue) => `GitHub Issue fetched: #${fetchedIssue.number} ${fetchedIssue.title}`,
      async () => fetchIssue(issueOption),
    );
    return { issues: [issue], initialInput: formatIssueAsTask(issue) };
  }

  if (task && isDirectTask(task)) {
    const ghStatus = checkGhCli();
    if (!ghStatus.available) {
      throw new Error(ghStatus.error);
    }
    const tokens = task.trim().split(/\s+/);
    const issueNumbers = parseIssueNumbers(tokens);
    if (issueNumbers.length === 0) {
      throw new Error(`Invalid issue reference: ${task}`);
    }
    const issues = await withProgress(
      'Fetching GitHub Issue...',
      (fetchedIssues) => `GitHub Issues fetched: ${fetchedIssues.map((issue) => `#${issue.number}`).join(', ')}`,
      async () => issueNumbers.map((n) => fetchIssue(n)),
    );
    return { issues, initialInput: issues.map(formatIssueAsTask).join('\n\n---\n\n') };
  }

  return null;
}

/**
 * Execute default action: handle task execution, pipeline mode, or interactive mode.
 * Exported for use in slash-command fallback logic.
 */
export async function executeDefaultAction(task?: string): Promise<void> {
  const opts = program.opts();
  const agentOverrides = resolveAgentOverrides(program);
  const createWorktreeOverride = parseCreateWorktreeOption(opts.createWorktree as string | undefined);
  const selectOptions: SelectAndExecuteOptions = {
    autoPr: opts.autoPr === true,
    repo: opts.repo as string | undefined,
    piece: opts.piece as string | undefined,
    createWorktree: createWorktreeOverride,
  };

  // --- Pipeline mode (non-interactive): triggered by --pipeline ---
  if (pipelineMode) {
    const exitCode = await executePipeline({
      issueNumber: opts.issue as number | undefined,
      task: opts.task as string | undefined,
      piece: (opts.piece as string | undefined) ?? DEFAULT_PIECE_NAME,
      branch: opts.branch as string | undefined,
      autoPr: opts.autoPr === true,
      repo: opts.repo as string | undefined,
      skipGit: opts.skipGit === true,
      cwd: resolvedCwd,
      provider: agentOverrides?.provider,
      model: agentOverrides?.model,
    });

    if (exitCode !== 0) {
      process.exit(exitCode);
    }
    return;
  }

  // --- Normal (interactive) mode ---

  // Resolve --task option to task text (direct execution, no interactive mode)
  const taskFromOption = opts.task as string | undefined;
  if (taskFromOption) {
    await selectAndExecuteTask(resolvedCwd, taskFromOption, selectOptions, agentOverrides);
    return;
  }

  // Resolve issue references (--issue N or #N positional arg) before interactive mode
  let initialInput: string | undefined = task;

  try {
    const issueResult = await resolveIssueInput(opts.issue as number | undefined, task);
    if (issueResult) {
      selectOptions.issues = issueResult.issues;
      initialInput = issueResult.initialInput;
    }
  } catch (e) {
    error(getErrorMessage(e));
    process.exit(1);
  }

  // All paths below go through interactive mode
  const globalConfig = loadGlobalConfig();
  const lang = resolveLanguage(globalConfig.language);

  const pieceId = await determinePiece(resolvedCwd, selectOptions.piece);
  if (pieceId === null) {
    info(getLabel('interactive.ui.cancelled', lang));
    return;
  }

  const previewCount = globalConfig.interactivePreviewMovements;
  const pieceDesc = getPieceDescription(pieceId, resolvedCwd, previewCount);

  // Mode selection after piece selection
  const selectedMode = await selectInteractiveMode(lang, pieceDesc.interactiveMode);
  if (selectedMode === null) {
    info(getLabel('interactive.ui.cancelled', lang));
    return;
  }

  const pieceContext = {
    name: pieceDesc.name,
    description: pieceDesc.description,
    pieceStructure: pieceDesc.pieceStructure,
    movementPreviews: pieceDesc.movementPreviews,
  };

  let result: InteractiveModeResult;

  switch (selectedMode) {
    case 'assistant': {
      let selectedSessionId: string | undefined;
      const provider = globalConfig.provider;
      if (provider === 'claude') {
        const shouldSelectSession = await confirm(
          getLabel('interactive.sessionSelector.confirm', lang),
          false,
        );
        if (shouldSelectSession) {
          const sessionId = await selectRecentSession(resolvedCwd, lang);
          if (sessionId) {
            selectedSessionId = sessionId;
          }
        }
      }
      result = await interactiveMode(resolvedCwd, initialInput, pieceContext, selectedSessionId);
      break;
    }

    case 'passthrough':
      result = await passthroughMode(lang, initialInput);
      break;

    case 'quiet':
      result = await quietMode(resolvedCwd, initialInput, pieceContext);
      break;

    case 'persona': {
      if (!pieceDesc.firstMovement) {
        info(getLabel('interactive.ui.personaFallback', lang));
        result = await interactiveMode(resolvedCwd, initialInput, pieceContext);
      } else {
        result = await personaMode(resolvedCwd, pieceDesc.firstMovement, initialInput, pieceContext);
      }
      break;
    }
  }

  await dispatchConversationAction(result, {
    execute: async ({ task: confirmedTask }) => {
      selectOptions.interactiveUserInput = true;
      selectOptions.piece = pieceId;
      selectOptions.interactiveMetadata = { confirmed: true, task: confirmedTask };
      await selectAndExecuteTask(resolvedCwd, confirmedTask, selectOptions, agentOverrides);
    },
    create_issue: async ({ task: confirmedTask }) => {
      const issueNumber = createIssueFromTask(confirmedTask);
      if (issueNumber !== undefined) {
        await saveTaskFromInteractive(resolvedCwd, confirmedTask, pieceId, {
          issue: issueNumber,
          confirmAtEndMessage: 'Add this issue to tasks?',
        });
      }
    },
    save_task: async ({ task: confirmedTask }) => {
      await saveTaskFromInteractive(resolvedCwd, confirmedTask, pieceId);
    },
    cancel: () => undefined,
  });
}

program
  .argument('[task]', 'Task to execute (or GitHub issue reference like "#6")')
  .action(executeDefaultAction);
