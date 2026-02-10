/**
 * CLI subcommand definitions
 *
 * Registers all named subcommands (run, watch, add, list, switch, clear, eject, config, prompt, catalog).
 */

import { clearPersonaSessions, getCurrentPiece } from '../../infra/config/index.js';
import { success } from '../../shared/ui/index.js';
import { runAllTasks, addTask, watchTasks, listTasks } from '../../features/tasks/index.js';
import { switchPiece, switchConfig, ejectBuiltin, ejectFacet, parseFacetType, VALID_FACET_TYPES, resetCategoriesToDefault, deploySkill } from '../../features/config/index.js';
import { previewPrompts } from '../../features/prompt/index.js';
import { showCatalog } from '../../features/catalog/index.js';
import { program, resolvedCwd } from './program.js';
import { resolveAgentOverrides } from './helpers.js';

program
  .command('run')
  .description('Run all pending tasks from .takt/tasks.yaml')
  .action(async () => {
    const piece = getCurrentPiece(resolvedCwd);
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

program
  .command('config')
  .description('Configure settings (permission mode)')
  .argument('[key]', 'Configuration key')
  .action(async (key?: string) => {
    await switchConfig(resolvedCwd, key);
  });

const reset = program
  .command('reset')
  .description('Reset settings to defaults');

reset
  .command('categories')
  .description('Reset piece categories to builtin defaults')
  .action(async () => {
    await resetCategoriesToDefault();
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
