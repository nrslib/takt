export class ToolHistoryPersistenceError extends Error {
  constructor(cause: unknown) {
    super('Tool history could not be saved', { cause });
    this.name = 'ToolHistoryPersistenceError';
  }
}
