/**
 * CLI subcommand definitions
 *
 * Registers all named subcommands (run, watch, add, list, clear, eject, prompt, catalog).
 */

import { join } from 'node:path';
import type { Command } from 'commander';
import { clearPersonaSessions, resolveConfigValue } from '../../infra/config/index.js';
import { getGlobalConfigDir } from '../../infra/config/paths.js';
import { success, info, error as logError } from '../../shared/ui/index.js';
import { runAllTasks, addTask, watchTasks, listTasks } from '../../features/tasks/index.js';
import {
  ejectBuiltin,
  ejectFacet,
  parseFacetType,
  VALID_FACET_TYPES,
  resetCategoriesToDefault,
  resetConfigToDefault,
  deploySkill,
  deploySkillCodex,
} from '../../features/config/index.js';
import { previewPrompts } from '../../features/prompt/index.js';
import { showCatalog } from '../../features/catalog/index.js';
import { computeReviewMetrics, formatReviewMetrics, parseSinceDuration, purgeOldEvents } from '../../features/analytics/index.js';
import { doctorWorkflowCommand, initWorkflowCommand } from '../../features/workflowAuthoring/index.js';
import { program, resolvedCwd } from './program.js';
import { resolveAgentOverrides, resolveWorkflowCliOption } from './helpers.js';
import { repertoireAddCommand } from '../../commands/repertoire/add.js';
import { repertoireRemoveCommand } from '../../commands/repertoire/remove.js';
import { repertoireListCommand } from '../../commands/repertoire/list.js';

program
  .command('run')
  .description('Run all pending tasks from .takt/tasks.yaml')
  .option('--ignore-exceed', 'Ignore workflow max_steps and continue running tasks')
  .action(async (_opts, command) => {
    const opts = command.optsWithGlobals();
    await runAllTasks(resolvedCwd, {
      ...resolveAgentOverrides(program),
      ignoreExceed: opts.ignoreExceed === true,
    });
  });

program
  .command('watch')
  .description('Watch for tasks and auto-execute')
  .option('--ignore-exceed', 'Ignore workflow max_steps and continue running tasks')
  .action(async (_opts, command) => {
    const opts = command.optsWithGlobals();
    await watchTasks(resolvedCwd, {
      ...resolveAgentOverrides(program),
      ignoreExceed: opts.ignoreExceed === true,
    });
  });

program
  .command('add')
  .description('Add a new task')
  .argument('[task]', 'Task description or issue reference (e.g. "#28")')
  .action(async (task: string | undefined, commandOrOpts?: Command | { opts?: () => Record<string, unknown> }) => {
    const optsWithGlobals = (
      commandOrOpts && 'optsWithGlobals' in commandOrOpts && typeof commandOrOpts.optsWithGlobals === 'function'
    )
      ? commandOrOpts.optsWithGlobals.bind(commandOrOpts)
      : undefined;
    const opts = optsWithGlobals
      ? optsWithGlobals()
      : (typeof commandOrOpts?.opts === 'function' ? commandOrOpts.opts() : program.opts());
    let workflow: string | undefined;
    try {
      workflow = resolveWorkflowCliOption(opts as Record<string, unknown>);
    } catch (error) {
      logError(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
    const addTaskOptions = {
      ...(opts.pr !== undefined ? { prNumber: opts.pr as number } : {}),
      ...(workflow !== undefined ? { workflow } : {}),
    };
    await addTask(
      resolvedCwd,
      task,
      Object.keys(addTaskOptions).length > 0 ? addTaskOptions : undefined,
    );
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
  .description('Copy builtin workflow or facet for customization (default: project .takt/)')
  .argument('[typeOrName]', `Workflow name, or facet type (${VALID_FACET_TYPES.join(', ')})`)
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
  .description('Reset workflow categories to builtin defaults')
  .action(async () => {
    await resetCategoriesToDefault(resolvedCwd);
  });

program
  .command('prompt')
  .description('Preview assembled prompts for each step and phase')
  .argument('[workflow]', 'Workflow name or path (defaults to "default")')
  .action(async (workflow?: string) => {
    await previewPrompts(resolvedCwd, workflow);
  });

program
  .command('export-cc')
  .description('Export takt workflows/agents as Claude Code Skill (~/.claude/)')
  .action(async () => {
    await deploySkill();
  });

program
  .command('export-codex')
  .description('Export takt workflows/agents as Codex Skill (~/.agents/)')
  .action(async () => {
    await deploySkillCodex();
  });

program
  .command('catalog')
  .description('List available facets (personas, policies, knowledge, instructions, output-contracts)')
  .argument('[type]', 'Facet type to list')
  .action((type?: string) => {
    showCatalog(resolvedCwd, type);
  });

const workflow = program
  .command('workflow')
  .description('Workflow authoring utilities');

workflow
  .command('init')
  .description('Initialize a new workflow scaffold')
  .argument('<name>', 'Workflow name')
  .option('--description <text>', 'Workflow description')
  .option('--steps <count>', 'Initial number of steps', (value: string) => parseInt(value, 10))
  .option('--template <kind>', 'Template kind (minimal|faceted)')
  .option('--global', 'Create in ~/.takt/workflows instead of project .takt/workflows')
  .action(async (name: string, opts: {
    description?: string;
    global?: boolean;
    steps?: number;
    template?: 'minimal' | 'faceted';
  }) => {
    await initWorkflowCommand(name, {
      description: opts.description,
      global: opts.global,
      steps: opts.steps,
      template: opts.template,
      projectDir: resolvedCwd,
    });
  });

workflow
  .command('doctor')
  .description('Validate workflow definitions')
  .argument('[targets...]', 'Workflow names or YAML paths')
  .action(async (targets: string[] | undefined) => {
    await doctorWorkflowCommand(targets ?? [], resolvedCwd);
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
