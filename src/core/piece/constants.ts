/**
 * Piece engine constants
 *
 * Contains all constants used by the piece engine including
 * special movement names, limits, and error messages.
 */

/** Special movement names for piece termination */
export const COMPLETE_MOVEMENT = 'COMPLETE';
export const ABORT_MOVEMENT = 'ABORT';

/** Maximum user inputs to store */
export const MAX_USER_INPUTS = 100;
export const MAX_INPUT_LENGTH = 10000;

/** Error messages */
export const ERROR_MESSAGES = {
  LOOP_DETECTED: (movementName: string, count: number) =>
    `Loop detected: movement "${movementName}" ran ${count} times consecutively without progress.`,
  UNKNOWN_MOVEMENT: (movementName: string) => `Unknown movement: ${movementName}`,
  MOVEMENT_EXECUTION_FAILED: (message: string) => `Movement execution failed: ${message}`,
  MAX_MOVEMENTS_REACHED: 'Max movements reached',
};
