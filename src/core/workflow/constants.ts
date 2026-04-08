/**
 * Workflow engine constants
 *
 * Contains all constants used by the workflow engine including
 * special step names, limits, and error messages.
 */

/** Special step names for workflow termination */
export const COMPLETE_STEP = 'COMPLETE';
export const ABORT_STEP = 'ABORT';

/** Maximum user inputs to store */
export const MAX_USER_INPUTS = 100;
export const MAX_INPUT_LENGTH = 10000;

/** Error messages */
export const ERROR_MESSAGES = {
  LOOP_DETECTED: (stepName: string, count: number) =>
    `Loop detected: step "${stepName}" ran ${count} times consecutively without progress.`,
  UNKNOWN_STEP: (stepName: string) => `Unknown step: ${stepName}`,
  STEP_EXECUTION_FAILED: (message: string) => `Step execution failed: ${message}`,
  MAX_STEPS_REACHED: 'Max steps reached',
};
