import type { WorkflowConfig } from '../../core/models/index.js';
import { WorkflowEngine as WorkflowEngineImpl } from '../../core/workflow/index.js';
import type { WorkflowEngineOptions } from '../../core/workflow/types.js';

export class WorkflowEngine extends WorkflowEngineImpl {
  constructor(
    config: WorkflowConfig,
    cwd: string,
    task: string,
    options: WorkflowEngineOptions,
  ) {
    super(config, cwd, task, options);
  }
}
