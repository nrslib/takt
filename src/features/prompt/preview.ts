/**
 * Prompt preview feature
 *
 * Loads a workflow and displays the assembled prompt for each step and phase.
 * Useful for debugging and understanding what prompts agents will receive.
 */

import { loadWorkflowByIdentifier, resolveWorkflowConfigValue } from '../../infra/config/index.js';
import { InstructionBuilder } from '../../core/workflow/instruction/InstructionBuilder.js';
import { ReportInstructionBuilder } from '../../core/workflow/instruction/ReportInstructionBuilder.js';
import { StatusJudgmentBuilder } from '../../core/workflow/instruction/StatusJudgmentBuilder.js';
import { needsStatusJudgmentPhase } from '../../core/workflow/index.js';
import type { InstructionContext } from '../../core/workflow/instruction/instruction-context.js';
import type { Language } from '../../core/models/types.js';
import { header, info, error, blankLine } from '../../shared/ui/index.js';
import { DEFAULT_WORKFLOW_NAME } from '../../shared/constants.js';
import { sanitizeTerminalText } from '../../shared/utils/text.js';

/**
 * Preview all prompts for a workflow.
 *
 * Loads the workflow definition, then for each step builds and displays
 * the Phase 1, Phase 2, and Phase 3 prompts with sample variable values.
 */
export async function previewPrompts(cwd: string, workflowIdentifier?: string): Promise<void> {
  const identifier = workflowIdentifier ?? DEFAULT_WORKFLOW_NAME;
  const config = loadWorkflowByIdentifier(identifier, cwd);
  const safeIdentifier = sanitizeTerminalText(identifier);

  if (!config) {
    error(`Workflow "${safeIdentifier}" not found.`);
    return;
  }

  const language = resolveWorkflowConfigValue(cwd, 'language') as Language;
  const safeWorkflowName = sanitizeTerminalText(config.name);

  header(`Workflow Prompt Preview: ${safeWorkflowName}`);
  info(`Steps: ${config.steps.length}`);
  info(`Language: ${language}`);
  blankLine();

  for (const [i, step] of config.steps.entries()) {
    const separator = '='.repeat(60);
    const safeStepName = sanitizeTerminalText(step.name);
    const safePersonaDisplayName = sanitizeTerminalText(step.personaDisplayName);

    console.log(separator);
    console.log(`Step ${i + 1}: ${safeStepName} (persona: ${safePersonaDisplayName})`);
    console.log(separator);

    // Phase 1: Main execution
    const context: InstructionContext = {
      task: '<task content>',
      iteration: 1,
      maxSteps: config.maxSteps,
      stepIteration: 1,
      cwd,
      projectCwd: cwd,
      userInputs: [],
      workflowSteps: config.steps,
      currentStepIndex: i,
      reportDir: step.outputContracts && step.outputContracts.length > 0 ? '.takt/runs/preview/reports' : undefined,
      language,
    };

    const phase1Builder = new InstructionBuilder(step, context);
    console.log('\n--- Phase 1 (Main Execution) ---\n');
    console.log(phase1Builder.build());

    // Phase 2: Report output (only if step has output contracts)
    if (step.outputContracts && step.outputContracts.length > 0) {
      const reportBuilder = new ReportInstructionBuilder(step, {
        cwd,
        reportDir: '.takt/runs/preview/reports',
        stepIteration: 1,
        language,
      });
      console.log('\n--- Phase 2 (Report Output) ---\n');
      console.log(reportBuilder.build());
    }

    // Phase 3: Status judgment (only if step has tag-based rules)
    if (needsStatusJudgmentPhase(step)) {
      const judgmentBuilder = new StatusJudgmentBuilder(step, { language });
      console.log('\n--- Phase 3 (Status Judgment) ---\n');
      console.log(judgmentBuilder.build());
    }

    blankLine();
  }
}
