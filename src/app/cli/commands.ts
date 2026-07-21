/**
 * CLI subcommand definitions
 */

import { join } from 'node:path';
import type { Command } from 'commander';
import type { RoutingTelemetryStatus } from '../../infra/config/global/globalConfigAccessors.js';
import { parseFacetType, VALID_FACET_TYPES } from '../../features/config/facetTypes.js';
import { program } from './program.js';
import { resolveAgentOverrides, resolveWorkflowCliOption } from './helpers.js';

program
  .command('run')
  .description('Run all pending tasks from .takt/tasks.yaml')
  .option('--ignore-exceed', 'Ignore workflow max_steps and continue running tasks')
  .action(async (_opts, command) => {
    const { getCliExecutionContext } = await import('./initialization.js');
    const { runAllTasks } = await import('../../features/tasks/execute/runAllTasks.js');
    const opts = command.optsWithGlobals();
    await runAllTasks(getCliExecutionContext().cwd, {
      ...resolveAgentOverrides(program),
      ...(opts.ignoreExceed === true ? { ignoreExceed: true } : {}),
    });
  });

program
  .command('watch')
  .description('Watch for tasks and auto-execute')
  .option('--ignore-exceed', 'Ignore workflow max_steps and continue running tasks')
  .action(async (_opts, command) => {
    const { getCliExecutionContext } = await import('./initialization.js');
    const { watchTasks } = await import('../../features/tasks/watch/index.js');
    const opts = command.optsWithGlobals();
    await watchTasks(getCliExecutionContext().cwd, {
      ...resolveAgentOverrides(program),
      ...(opts.ignoreExceed === true ? { ignoreExceed: true } : {}),
    });
  });

program
  .command('add')
  .description('Add a new task')
  .argument('[task]', 'Task description or issue reference (e.g. "#28")')
  .action(async (task: string | undefined, commandOrOpts?: Command | { opts?: () => Record<string, unknown> }) => {
    const { getCliExecutionContext } = await import('./initialization.js');
    const { addTask } = await import('../../features/tasks/add/index.js');
    const { error: logError } = await import('../../shared/ui/index.js');
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
      getCliExecutionContext().cwd,
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
    const { getCliExecutionContext } = await import('./initialization.js');
    const { listTasks } = await import('../../features/tasks/list/index.js');
    const opts = command.optsWithGlobals();
    await listTasks(
      getCliExecutionContext().cwd,
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
  .command('resume')
  .description('Resume the latest failed or aborted direct run')
  .action(async () => {
    const { getCliExecutionContext } = await import('./initialization.js');
    const { resumeDirectRun } = await import('../../features/tasks/resume/index.js');
    await resumeDirectRun(getCliExecutionContext().cwd, resolveAgentOverrides(program));
  });

program
  .command('exec')
  .description('Start instant multi-agent exec mode')
  .argument('[preset]', 'Exec preset name')
  .option('--list', 'List exec presets')
  .action(async (preset: string | undefined, opts: { list?: boolean }) => {
    const { getCliExecutionContext } = await import('./initialization.js');
    const { runExecCommand } = await import('../../features/exec/command.js');
    await runExecCommand(getCliExecutionContext().cwd, {
      preset,
      list: opts.list === true,
      agentOverrides: resolveAgentOverrides(program),
    });
  });

program
  .command('clear')
  .description('Clear agent conversation sessions')
  .action(async () => {
    const { getCliExecutionContext } = await import('./initialization.js');
    const { clearPersonaSessions } = await import('../../infra/config/project/sessionStore.js');
    const { success } = await import('../../shared/ui/index.js');
    clearPersonaSessions(getCliExecutionContext().cwd);
    success('Agent sessions cleared');
  });

program
  .command('eject')
  .description('Copy builtin workflow or facet for customization (default: project .takt/)')
  .argument('[typeOrName]', `Workflow name, or facet type (${VALID_FACET_TYPES.join(', ')})`)
  .argument('[facetName]', 'Facet name (when first arg is a facet type)')
  .option('--global', 'Eject to ~/.takt/ instead of project .takt/')
  .action(async (typeOrName: string | undefined, facetName: string | undefined, opts: { global?: boolean }) => {
    const { getCliExecutionContext } = await import('./initialization.js');
    const { ejectBuiltin, ejectFacet } = await import('../../features/config/ejectBuiltin.js');
    const ejectOptions = { global: opts.global, projectDir: getCliExecutionContext().cwd };

    if (typeOrName && facetName) {
      const facetType = parseFacetType(typeOrName);
      if (!facetType) {
        const { sanitizeTerminalText } = await import('../../shared/utils/text.js');
        console.error(`Invalid facet type: ${sanitizeTerminalText(typeOrName)}. Valid types: ${VALID_FACET_TYPES.join(', ')}`);
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
    const { resetConfigToDefault } = await import('../../features/config/resetConfig.js');
    await resetConfigToDefault();
  });

reset
  .command('categories')
  .description('Reset workflow categories to builtin defaults')
  .action(async () => {
    const { getCliExecutionContext } = await import('./initialization.js');
    const { resetCategoriesToDefault } = await import('../../features/config/resetCategories.js');
    await resetCategoriesToDefault(getCliExecutionContext().cwd);
  });

program
  .command('prompt')
  .description('Preview assembled prompts for each step and phase')
  .argument('[workflow]', 'Workflow name or path (defaults to "default")')
  .action(async (workflow?: string) => {
    const { getCliExecutionContext } = await import('./initialization.js');
    const { previewPrompts } = await import('../../features/prompt/preview.js');
    await previewPrompts(getCliExecutionContext().cwd, workflow);
  });

program
  .command('export-cc')
  .description('Export takt workflows/agents as Claude Code Skill (~/.claude/)')
  .action(async () => {
    const { deploySkill } = await import('../../features/config/deploySkill.js');
    await deploySkill();
  });

program
  .command('export-codex')
  .description('Export takt workflows/agents as Codex Skill (~/.agents/)')
  .action(async () => {
    const { deploySkillCodex } = await import('../../features/config/deploySkillCodex.js');
    await deploySkillCodex();
  });

program
  .command('catalog')
  .description('List available facets (personas, policies, knowledge, instructions, output-contracts)')
  .argument('[type]', 'Facet type to list')
  .action(async (type?: string) => {
    const { getCliExecutionContext } = await import('./initialization.js');
    const { showCatalog } = await import('../../features/catalog/catalogFacets.js');
    showCatalog(getCliExecutionContext().cwd, type);
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
    const { getCliExecutionContext } = await import('./initialization.js');
    const { initWorkflowCommand } = await import('../../features/workflowAuthoring/init.js');
    await initWorkflowCommand(name, {
      description: opts.description,
      global: opts.global,
      steps: opts.steps,
      template: opts.template,
      projectDir: getCliExecutionContext().cwd,
    });
  });

workflow
  .command('doctor')
  .description('Validate workflow definitions')
  .argument('[targets...]', 'Workflow names or YAML paths')
  .action(async (targets: string[] | undefined) => {
    const { getCliExecutionContext } = await import('./initialization.js');
    const { doctorWorkflowCommand } = await import('../../features/workflowAuthoring/doctor.js');
    await doctorWorkflowCommand(targets ?? [], getCliExecutionContext().cwd);
  });

const metrics = program
  .command('metrics')
  .description('Show analytics metrics');

metrics
  .command('review')
  .description('Show review quality metrics')
  .option('--since <duration>', 'Time window (e.g. "7d", "30d")', '30d')
  .action(async (opts: { since: string }) => {
    const { getCliExecutionContext } = await import('./initialization.js');
    const { getGlobalConfigDir } = await import('../../infra/config/paths.js');
    const { resolveConfigValue } = await import('../../infra/config/resolveConfigValue.js');
    const { computeReviewMetrics, formatReviewMetrics, parseSinceDuration } = await import('../../features/analytics/metrics.js');
    const { info } = await import('../../shared/ui/index.js');
    const analytics = resolveConfigValue(getCliExecutionContext().cwd, 'analytics');
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
  .action(async (opts: { retentionDays: string }) => {
    const { getCliExecutionContext } = await import('./initialization.js');
    const { getGlobalConfigDir } = await import('../../infra/config/paths.js');
    const { resolveConfigValue } = await import('../../infra/config/resolveConfigValue.js');
    const { purgeOldEvents } = await import('../../features/analytics/purge.js');
    const { info, success } = await import('../../shared/ui/index.js');
    const analytics = resolveConfigValue(getCliExecutionContext().cwd, 'analytics');
    const eventsDir = analytics?.eventsPath ?? join(getGlobalConfigDir(), 'analytics', 'events');
    const retentionDays = analytics?.retentionDays ?? parseInt(opts.retentionDays, 10);
    const deleted = purgeOldEvents(eventsDir, retentionDays, new Date());
    if (deleted.length === 0) {
      info('No files to purge.');
    } else {
      const { sanitizeTerminalText } = await import('../../shared/utils/text.js');
      success(`Purged ${deleted.length} file(s): ${sanitizeTerminalText(deleted.join(', '))}`);
    }
  });

const telemetry = program
  .command('telemetry')
  .description('Manage TAKT local routing event recording');

telemetry
  .command('status')
  .description('Show local routing event recording status')
  .action(async () => {
    const { getCliExecutionContext } = await import('./initialization.js');
    const { getRoutingTelemetryStatus } = await import('../../infra/config/global/globalConfigAccessors.js');
    const { info } = await import('../../shared/ui/index.js');
    info(formatRoutingTelemetryStatus(getRoutingTelemetryStatus(getCliExecutionContext().cwd)));
  });

telemetry
  .command('enable')
  .description('Enable local routing event recording')
  .action(async () => {
    const { getCliExecutionContext } = await import('./initialization.js');
    const { enableRoutingTelemetry } = await import('../../infra/config/global/globalConfigAccessors.js');
    const { info } = await import('../../shared/ui/index.js');
    const status = enableRoutingTelemetry(getCliExecutionContext().cwd);
    info(formatRoutingTelemetryStatus(status));
  });

telemetry
  .command('disable')
  .description('Disable local routing event recording')
  .action(async () => {
    const { getCliExecutionContext } = await import('./initialization.js');
    const { disableRoutingTelemetry } = await import('../../infra/config/global/globalConfigAccessors.js');
    const { success } = await import('../../shared/ui/index.js');
    const status = disableRoutingTelemetry(getCliExecutionContext().cwd);
    success(formatRoutingTelemetryStatus(status));
  });

const repertoire = program
  .command('repertoire')
  .description('Manage repertoire packages');

repertoire
  .command('add')
  .description('Install a repertoire package from GitHub')
  .argument('<spec>', 'Package spec (e.g. github:{owner}/{repo}@{ref})')
  .action(async (spec: string) => {
    const { repertoireAddCommand } = await import('../../commands/repertoire/add.js');
    await repertoireAddCommand(spec);
  });

repertoire
  .command('remove')
  .description('Remove an installed repertoire package')
  .argument('<scope>', 'Package scope (e.g. @{owner}/{repo})')
  .action(async (scope: string) => {
    const { repertoireRemoveCommand } = await import('../../commands/repertoire/remove.js');
    await repertoireRemoveCommand(scope);
  });

repertoire
  .command('list')
  .description('List installed repertoire packages')
  .action(async () => {
    const { repertoireListCommand } = await import('../../commands/repertoire/list.js');
    await repertoireListCommand();
  });

function formatRoutingTelemetryStatus(status: RoutingTelemetryStatus): string {
  const state = status.localRecordingEnabled ? 'enabled' : 'disabled';
  return `Routing decision recording is local only and writes to .takt/events. Local recording: ${state}.`;
}
