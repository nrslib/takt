/**
 * CLI subcommand definitions
 *
 * Registers all named subcommands (run, watch, add, list, switch, clear, eject, prompt, catalog).
 */

import { join } from 'node:path';
import { clearPersonaSessions, resolveConfigValue } from '../../infra/config/index.js';
import { getGlobalConfigDir } from '../../infra/config/paths.js';
import { success, info } from '../../shared/ui/index.js';
import { runAllTasks, addTask, watchTasks, listTasks } from '../../features/tasks/index.js';
import { switchPiece, ejectInteractive, resetCategoriesToDefault, resetConfigToDefault, deploySkill } from '../../features/config/index.js';
import { previewPrompts } from '../../features/prompt/index.js';
import { showCatalog } from '../../features/catalog/index.js';
import { computeReviewMetrics, formatReviewMetrics, parseSinceDuration, purgeOldEvents } from '../../features/analytics/index.js';
import { program, resolvedCwd } from './program.js';
import { resolveAgentOverrides } from './helpers.js';

program
  .command('run')
  .description('Run all pending tasks from .takt/tasks.yaml')
  .action(async () => {
    const piece = resolveConfigValue(resolvedCwd, 'piece');
    await runAllTasks(resolvedCwd, piece, resolveAgentOverrides(program));
  });

program
  .command('watch')
  .description('Watch for tasks and auto-execute')
  .action(async () => {
    await watchTasks(resolvedCwd, resolveAgentOverrides(program));
  });

program
  .command('add')
  .description('Add a new task')
  .argument('[task]', 'Task description or GitHub issue reference (e.g. "#28")')
  .action(async (task?: string) => {
    await addTask(resolvedCwd, task);
  });

program
  .command('list')
  .description('List task branches (merge/delete)')
  .option('--non-interactive', 'Run list in non-interactive mode')
  .option('--action <action>', 'Non-interactive action (diff|try|merge|delete)')
  .option('--format <format>', 'Output format for non-interactive list (text|json)')
  .option('--yes', 'Skip confirmation prompts in non-interactive mode')
  .action(async (_opts, command) => {
    const opts = command.optsWithGlobals();
    await listTasks(
      resolvedCwd,
      resolveAgentOverrides(program),
      {
        enabled: opts.nonInteractive === true,
        action: opts.action as string | undefined,
        branch: opts.branch as string | undefined,
        format: opts.format as string | undefined,
        yes: opts.yes === true,
      },
    );
  });

program
  .command('switch')
  .description('Switch piece interactively')
  .argument('[piece]', 'Piece name')
  .action(async (piece?: string) => {
    await switchPiece(resolvedCwd, piece);
  });

program
  .command('clear')
  .description('Clear agent conversation sessions')
  .action(() => {
    clearPersonaSessions(resolvedCwd);
    success('Agent sessions cleared');
  });

program
  .command('eject')
  .description('Copy builtin piece or facet for customization (default: project .takt/)')
  .action(async () => {
    await ejectInteractive(resolvedCwd);
  });

const reset = program
  .command('reset')
  .description('Reset settings to defaults');

reset
  .command('config')
  .description('Reset global config to builtin template (with backup)')
  .action(async () => {
    await resetConfigToDefault();
  });

reset
  .command('categories')
  .description('Reset piece categories to builtin defaults')
  .action(async () => {
    await resetCategoriesToDefault(resolvedCwd);
  });

program
  .command('prompt')
  .description('Preview assembled prompts for each movement and phase')
  .argument('[piece]', 'Piece name or path (defaults to current)')
  .action(async (piece?: string) => {
    await previewPrompts(resolvedCwd, piece);
  });

program
  .command('export-cc')
  .description('Export takt pieces/agents as Claude Code Skill (~/.claude/)')
  .action(async () => {
    await deploySkill();
  });

program
  .command('catalog')
  .description('List available facets (personas, policies, knowledge, instructions, output-contracts)')
  .argument('[type]', 'Facet type to list')
  .action((type?: string) => {
    showCatalog(resolvedCwd, type);
  });

const metrics = program
  .command('metrics')
  .description('Show analytics metrics');

metrics
  .command('review')
  .description('Show review quality metrics')
  .option('--since <duration>', 'Time window (e.g. "7d", "30d")', '30d')
  .action((opts: { since: string }) => {
    const analytics = resolveConfigValue(resolvedCwd, 'analytics');
    const eventsDir = analytics?.eventsPath ?? join(getGlobalConfigDir(), 'analytics', 'events');
    const durationMs = parseSinceDuration(opts.since);
    const sinceMs = Date.now() - durationMs;
    const result = computeReviewMetrics(eventsDir, sinceMs);
    info(formatReviewMetrics(result));
  });

program
  .command('purge')
  .description('Purge old analytics event files')
  .option('--retention-days <days>', 'Retention period in days', '30')
  .action((opts: { retentionDays: string }) => {
    const analytics = resolveConfigValue(resolvedCwd, 'analytics');
    const eventsDir = analytics?.eventsPath ?? join(getGlobalConfigDir(), 'analytics', 'events');
    const retentionDays = analytics?.retentionDays
      ?? parseInt(opts.retentionDays, 10);
    const deleted = purgeOldEvents(eventsDir, retentionDays, new Date());
    if (deleted.length === 0) {
      info('No files to purge.');
    } else {
      success(`Purged ${deleted.length} file(s): ${deleted.join(', ')}`);
    }
  });
