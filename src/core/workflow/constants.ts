/**
 * Workflow engine constants
 *
 * Contains all constants used by the workflow engine including
 * special step names, limits, and error messages.
 */

/** Special step names for workflow termination */
export const COMPLETE_STEP = 'COMPLETE';
export const ABORT_STEP = 'ABORT';

/**
 * Terminal target for a provisional fixpoint stop. Like
 * COMPLETE_STEP/ABORT_STEP this is a pure
 * routing marker — no step object is synthesized for it (unlike
 * FINDING_CONFLICT_ADJUDICATION_STEP, which is a real synthesized step). A
 * workflow routes here via `next: NEEDS_ADJUDICATION` once
 * findings.provisional.fixpoint is true; the engine turns that into a
 * non-success, resumable abort ('needs_adjudication') carrying the open
 * provisional findings and their origin, instead of running the step it
 * transitioned from again.
 */
export const NEEDS_ADJUDICATION_STEP = 'NEEDS_ADJUDICATION';

/**
 * Reserved name of the engine-synthesized conflict-adjudication step.
 * Workflow rules (and loop
 * monitor judge rules) may point `next:` at this name like any other step, but
 * it is never authored in workflow YAML — the name is reserved
 * (WorkflowValidator rejects user-defined steps that squat on it) and the
 * engine injects a real synthesized step into config.steps at construction
 * time (findings/adjudication-step.ts's injectFindingConflictAdjudicationStep),
 * dispatched to a dedicated executor (findings/adjudication-runner.ts) by
 * WorkflowEngineStepCoordinator. Being a real step, it participates in the
 * standard machinery: step:start/complete events, history, stepOutputs, spans,
 * resume points and the loop detector.
 */
export const FINDING_CONFLICT_ADJUDICATION_STEP = 'finding-conflict-adjudication';

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
