/**
 * Default action routing
 *
 * Handles the default (no subcommand) action: task execution,
 * pipeline mode, or interactive mode.
 */

import { info, error } from '../../shared/ui/index.js';
import { getErrorMessage } from '../../shared/utils/index.js';
import { fetchIssue, formatIssueAsTask, checkGhCli, parseIssueNumbers } from '../../infra/github/index.js';
import { selectAndExecuteTask, determinePiece, saveTaskFromInteractive, createIssueFromTask, type SelectAndExecuteOptions } from '../../features/tasks/index.js';
import { executePipeline } from '../../features/pipeline/index.js';
import { interactiveMode } from '../../features/interactive/index.js';
import { getPieceDescription } from '../../infra/config/index.js';
import { DEFAULT_PIECE_NAME } from '../../shared/constants.js';
import { program, resolvedCwd, pipelineMode } from './program.js';
import { resolveAgentOverrides, parseCreateWorktreeOption, isDirectTask } from './helpers.js';

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

  // Resolve --task option to task text
  const taskFromOption = opts.task as string | undefined;
  if (taskFromOption) {
    await selectAndExecuteTask(resolvedCwd, taskFromOption, selectOptions, agentOverrides);
    return;
  }

  // Resolve --issue N to task text (same as #N)
  const issueFromOption = opts.issue as number | undefined;
  if (issueFromOption) {
    try {
      const ghStatus = checkGhCli();
      if (!ghStatus.available) {
        throw new Error(ghStatus.error);
      }
      const issue = fetchIssue(issueFromOption);
      const resolvedTask = formatIssueAsTask(issue);
      selectOptions.issues = [issue];
      await selectAndExecuteTask(resolvedCwd, resolvedTask, selectOptions, agentOverrides);
    } catch (e) {
      error(getErrorMessage(e));
      process.exit(1);
    }
    return;
  }

  if (task && isDirectTask(task)) {
    // isDirectTask() returns true only for issue references (e.g., "#6" or "#1 #2")
    try {
      info('Fetching GitHub Issue...');
      const ghStatus = checkGhCli();
      if (!ghStatus.available) {
        throw new Error(ghStatus.error);
      }
      // Parse all issue numbers from task (supports "#6" and "#1 #2")
      const tokens = task.trim().split(/\s+/);
      const issueNumbers = parseIssueNumbers(tokens);
      if (issueNumbers.length === 0) {
        throw new Error(`Invalid issue reference: ${task}`);
      }
      const issues = issueNumbers.map((n) => fetchIssue(n));
      const resolvedTask = issues.map(formatIssueAsTask).join('\n\n---\n\n');
      selectOptions.issues = issues;
      await selectAndExecuteTask(resolvedCwd, resolvedTask, selectOptions, agentOverrides);
    } catch (e) {
      error(getErrorMessage(e));
      process.exit(1);
    }
    return;
  }

  // Non-issue inputs → interactive mode (with optional initial input)
  const pieceId = await determinePiece(resolvedCwd, selectOptions.piece);
  if (pieceId === null) {
    info('Cancelled');
    return;
  }

  const pieceContext = getPieceDescription(pieceId, resolvedCwd);
  const result = await interactiveMode(resolvedCwd, task, pieceContext);

  switch (result.action) {
    case 'execute':
      selectOptions.interactiveUserInput = true;
      selectOptions.piece = pieceId;
      selectOptions.interactiveMetadata = { confirmed: true, task: result.task };
      await selectAndExecuteTask(resolvedCwd, result.task, selectOptions, agentOverrides);
      break;

    case 'create_issue':
      createIssueFromTask(result.task);
      break;

    case 'save_task':
      await saveTaskFromInteractive(resolvedCwd, result.task, pieceId);
      break;

    case 'cancel':
      break;
  }
}

program
  .argument('[task]', 'Task to execute (or GitHub issue reference like "#6")')
  .action(executeDefaultAction);
