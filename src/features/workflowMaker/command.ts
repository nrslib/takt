import type { TaskExecutionOptions } from '../tasks/execute/types.js';
import { getLabel } from '../../shared/i18n/index.js';
import { error } from '../../shared/ui/index.js';
import { hasInteractiveTerminal } from '../../shared/utils/index.js';
import { resolveWorkflowConfigValue } from '../../infra/config/index.js';
import { runWorkflowMakerTui } from './tui.js';

export interface RunWorkflowMakerCommandOptions {
  readonly agentOverrides?: TaskExecutionOptions;
}

export async function runWorkflowMakerCommand(
  projectDir: string,
  options: RunWorkflowMakerCommandOptions = {},
): Promise<void> {
  const lang = resolveWorkflowConfigValue(projectDir, 'language');
  if (!hasInteractiveTerminal()) {
    error(getLabel('workflowMaker.ttyRequired', lang));
    process.exitCode = 1;
    return;
  }
  await runWorkflowMakerTui({
    projectDir,
    ...(options.agentOverrides === undefined ? {} : { agentOverrides: options.agentOverrides }),
  });
}
