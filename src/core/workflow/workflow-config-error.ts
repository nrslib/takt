import { ZodError } from 'zod';

export class WorkflowConfigError extends Error {
  private normalizedPath: readonly PropertyKey[];

  constructor(error: unknown, path: readonly PropertyKey[]) {
    const cause = error instanceof Error ? error : new Error(String(error));
    super(cause.message, { cause });
    this.name = 'WorkflowConfigError';
    this.normalizedPath = Object.freeze([...path]);
  }

  get path(): readonly PropertyKey[] {
    return this.normalizedPath;
  }

}

export function withWorkflowConfigErrorPath(error: unknown, path: readonly PropertyKey[]): WorkflowConfigError {
  if (
    error instanceof WorkflowConfigError
    && error.path.length >= path.length
    && path.every((entry, index) => error.path[index] === entry)
  ) {
    return error;
  }
  return new WorkflowConfigError(error, path);
}

export function getWorkflowConfigErrorPath(error: unknown): readonly PropertyKey[] | undefined {
  if (error instanceof WorkflowConfigError) {
    return error.path;
  }
  if (error instanceof ZodError) {
    return error.issues[0]?.path;
  }
  return undefined;
}
