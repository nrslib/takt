/**
 * Prompt preview feature
 *
 * Loads a piece and displays the assembled prompt for each movement and phase.
 * Useful for debugging and understanding what prompts agents will receive.
 */

import { loadPieceByIdentifier, resolvePieceConfigValue } from '../../infra/config/index.js';
import { InstructionBuilder } from '../../core/piece/instruction/InstructionBuilder.js';
import { ReportInstructionBuilder } from '../../core/piece/instruction/ReportInstructionBuilder.js';
import { StatusJudgmentBuilder } from '../../core/piece/instruction/StatusJudgmentBuilder.js';
import { needsStatusJudgmentPhase } from '../../core/piece/index.js';
import type { InstructionContext } from '../../core/piece/instruction/instruction-context.js';
import type { Language } from '../../core/models/types.js';
import { header, info, error, blankLine } from '../../shared/ui/index.js';
import { DEFAULT_PIECE_NAME } from '../../shared/constants.js';
import { sanitizeTerminalText } from '../../shared/utils/text.js';

/**
 * Preview all prompts for a piece.
 *
 * Loads the piece definition, then for each movement builds and displays
 * the Phase 1, Phase 2, and Phase 3 prompts with sample variable values.
 */
export async function previewPrompts(cwd: string, pieceIdentifier?: string): Promise<void> {
  const identifier = pieceIdentifier ?? DEFAULT_PIECE_NAME;
  const config = loadPieceByIdentifier(identifier, cwd);
  const safeIdentifier = sanitizeTerminalText(identifier);

  if (!config) {
    error(`Workflow "${safeIdentifier}" not found.`);
    return;
  }

  const language = resolvePieceConfigValue(cwd, 'language') as Language;
  const safeWorkflowName = sanitizeTerminalText(config.name);

  header(`Workflow Prompt Preview: ${safeWorkflowName}`);
  info(`Steps: ${config.movements.length}`);
  info(`Language: ${language}`);
  blankLine();

  for (const [i, movement] of config.movements.entries()) {
    const separator = '='.repeat(60);
    const safeMovementName = sanitizeTerminalText(movement.name);
    const safePersonaDisplayName = sanitizeTerminalText(movement.personaDisplayName);

    console.log(separator);
    console.log(`Step ${i + 1}: ${safeMovementName} (persona: ${safePersonaDisplayName})`);
    console.log(separator);

    // Phase 1: Main execution
    const context: InstructionContext = {
      task: '<task content>',
      iteration: 1,
      maxMovements: config.maxMovements,
      movementIteration: 1,
      cwd,
      projectCwd: cwd,
      userInputs: [],
      pieceMovements: config.movements,
      currentMovementIndex: i,
      reportDir: movement.outputContracts && movement.outputContracts.length > 0 ? '.takt/runs/preview/reports' : undefined,
      language,
    };

    const phase1Builder = new InstructionBuilder(movement, context);
    console.log('\n--- Phase 1 (Main Execution) ---\n');
    console.log(phase1Builder.build());

    // Phase 2: Report output (only if movement has output contracts)
    if (movement.outputContracts && movement.outputContracts.length > 0) {
      const reportBuilder = new ReportInstructionBuilder(movement, {
        cwd,
        reportDir: '.takt/runs/preview/reports',
        movementIteration: 1,
        language,
      });
      console.log('\n--- Phase 2 (Report Output) ---\n');
      console.log(reportBuilder.build());
    }

    // Phase 3: Status judgment (only if movement has tag-based rules)
    if (needsStatusJudgmentPhase(movement)) {
      const judgmentBuilder = new StatusJudgmentBuilder(movement, { language });
      console.log('\n--- Phase 3 (Status Judgment) ---\n');
      console.log(judgmentBuilder.build());
    }

    blankLine();
  }
}
