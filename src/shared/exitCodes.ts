/**
 * Process exit codes for takt CLI
 *
 * Fine-grained exit codes allow pipelines to distinguish
 * between different failure modes.
 */

export const EXIT_SUCCESS = 0;
export const EXIT_GENERAL_ERROR = 1;
export const EXIT_ISSUE_FETCH_FAILED = 2;
export const EXIT_WORKFLOW_FAILED = 3;
export const EXIT_GIT_OPERATION_FAILED = 4;
export const EXIT_PR_CREATION_FAILED = 5;
export const EXIT_SIGINT = 130; // 128 + SIGINT(2), UNIX convention
