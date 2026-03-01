/**
 * CLI subcommand definitions
 *
 * Registers all named subcommands (run, watch, add, list, clear, eject, prompt, catalog).
 */

import { join } from 'node:path';
import { clearPersonaSessions, resolveConfigValue } from '../../infra/config/index.js';
import { getGlobalConfigDir } from '../../infra/config/paths.js';
import { success, info, error } from '../../shared/ui/index.js';
import { runAllTasks, addTask, watchTasks, listTasks } from '../../features/tasks/index.js';
import { ejectBuiltin, ejectFacet, parseFacetType, VALID_FACET_TYPES, resetCategoriesToDefault, resetConfigToDefault, deploySkill } from '../../features/config/index.js';
import { previewPrompts } from '../../features/prompt/index.js';
import { showCatalog } from '../../features/catalog/index.js';
import { computeReviewMetrics, formatReviewMetrics, parseSinceDuration, purgeOldEvents } from '../../features/analytics/index.js';
import { program, resolvedCwd } from './program.js';
import { resolveAgentOverrides } from './helpers.js';
import { repertoireAddCommand } from '../../commands/repertoire/add.js';
import { repertoireRemoveCommand } from '../../commands/repertoire/remove.js';
import { repertoireListCommand } from '../../commands/repertoire/list.js';

program
  .command('run')
  .description('Run all pending tasks from .takt/tasks.yaml')
  .action(async () => {
    await runAllTasks(resolvedCwd, resolveAgentOverrides(program));
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
    const opts = program.opts();
    await addTask(resolvedCwd, task, opts.pr !== undefined ? { prNumber: opts.pr as number } : undefined);
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
  .command('clear')
  .description('Clear agent conversation sessions')
  .action(() => {
    clearPersonaSessions(resolvedCwd);
    success('Agent sessions cleared');
  });

program
  .command('eject')
  .description('Copy builtin piece or facet for customization (default: project .takt/)')
  .argument('[typeOrName]', `Piece name, or facet type (${VALID_FACET_TYPES.join(', ')})`)
  .argument('[facetName]', 'Facet name (when first arg is a facet type)')
  .option('--global', 'Eject to ~/.takt/ instead of project .takt/')
  .action(async (typeOrName: string | undefined, facetName: string | undefined, opts: { global?: boolean }) => {
    const ejectOptions = { global: opts.global, projectDir: resolvedCwd };

    if (typeOrName && facetName) {
      const facetType = parseFacetType(typeOrName);
      if (!facetType) {
        console.error(`Invalid facet type: ${typeOrName}. Valid types: ${VALID_FACET_TYPES.join(', ')}`);
        process.exitCode = 1;
        return;
      }
      await ejectFacet(facetType, facetName, ejectOptions);
    } else {
      await ejectBuiltin(typeOrName, ejectOptions);
    }
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
  .argument('[piece]', 'Piece name or path')
  .action(async (piece?: string) => {
    if (!piece) {
      error('Piece is required. Usage: takt prompt <piece>');
      return;
    }
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

const repertoire = program
  .command('repertoire')
  .description('Manage repertoire packages');

repertoire
  .command('add')
  .description('Install a repertoire package from GitHub')
  .argument('<spec>', 'Package spec (e.g. github:{owner}/{repo}@{ref})')
  .action(async (spec: string) => {
    await repertoireAddCommand(spec);
  });

repertoire
  .command('remove')
  .description('Remove an installed repertoire package')
  .argument('<scope>', 'Package scope (e.g. @{owner}/{repo})')
  .action(async (scope: string) => {
    await repertoireRemoveCommand(scope);
  });

repertoire
  .command('list')
  .description('List installed repertoire packages')
  .action(async () => {
    await repertoireListCommand();
  });
