/**
 * Template escaping and placeholder replacement utilities
 *
 * Used by instruction builders to process instruction_template content.
 *
 * escapeTemplateChars is re-exported from faceted-prompting.
 * replaceTemplatePlaceholders is TAKT-specific and stays here.
 */

import type { PieceMovement } from '../../models/types.js';
import type { InstructionContext } from './instruction-context.js';
import { escapeTemplateChars } from '../../../faceted-prompting/index.js';

export { escapeTemplateChars } from '../../../faceted-prompting/index.js';

/**
 * Replace template placeholders in the instruction_template body.
 *
 * These placeholders may still be used in instruction_template for
 * special cases or legacy templates.
 */
export function replaceTemplatePlaceholders(
  template: string,
  step: PieceMovement,
  context: InstructionContext,
): string {
  let result = template;

  // Replace {task}
  result = result.replace(/\{task\}/g, escapeTemplateChars(context.task));

  // Replace {iteration}, {max_movements}, and {movement_iteration}
  result = result.replace(/\{iteration\}/g, String(context.iteration));
  result = result.replace(/\{max_movements\}/g, String(context.maxMovements));
  result = result.replace(/\{movement_iteration\}/g, String(context.movementIteration));

  // Replace {previous_response}
  if (step.passPreviousResponse) {
    if (context.previousResponseText !== undefined) {
      result = result.replace(
        /\{previous_response\}/g,
        escapeTemplateChars(context.previousResponseText),
      );
    } else if (context.previousOutput) {
      result = result.replace(
        /\{previous_response\}/g,
        escapeTemplateChars(context.previousOutput.content),
      );
    } else {
      result = result.replace(/\{previous_response\}/g, '');
    }
  }

  // Replace {user_inputs}
  const userInputsStr = context.userInputs.join('\n');
  result = result.replace(
    /\{user_inputs\}/g,
    escapeTemplateChars(userInputsStr),
  );

  // Replace {report_dir}
  if (context.reportDir) {
    result = result.replace(/\{report_dir\}/g, context.reportDir);
  }

  // Replace {key} from vars (movement-specific variable substitution)
  if (step.vars) {
    for (const [key, value] of Object.entries(step.vars)) {
      // Escape regex special characters in the key to prevent regex injection
      const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const placeholder = new RegExp(`\\{${escapedKey}\\}`, 'g');
      result = result.replace(placeholder, escapeTemplateChars(value));
    }
  }

  // Replace {report:filename} with reportDir/filename
  if (context.reportDir) {
    result = result.replace(/\{report:([^}]+)\}/g, (_match, filename: string) => {
      return `${context.reportDir}/${filename}`;
    });
  }

  return result;
}
