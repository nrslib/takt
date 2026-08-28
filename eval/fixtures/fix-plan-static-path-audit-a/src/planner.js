import { loadPlannerSchema } from './loader.js';
import { selectDynamicFacets } from './selector-consumer.js';
import { findWorkflowCycle } from './cycle-consumer.js';
import { judgeLoop } from './loop-consumer.js';

export function buildPlan(input, config = loadPlannerSchema()) {
  return {
    selector: selectDynamicFacets(config, input),
    workflow: findWorkflowCycle(config, config.workflow.entry),
    loop: judgeLoop(config, input),
    terminal: 'plan with traceable execution paths',
  };
}
