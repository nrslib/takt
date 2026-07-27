import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  openSync,
} from 'node:fs';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

export class RunDatabaseFile {
  readonly #descriptor: number;
  #closed = false;

  constructor(descriptor: number) {
    this.#descriptor = descriptor;
  }

  sync(): void {
    if (this.#closed) {
      throw new Error('Run database file is closed');
    }
    fsyncSync(this.#descriptor);
  }

  close(database: DatabaseSync): void {
    if (this.#closed) {
      throw new Error('Run database file is already closed');
    }
    this.#closed = true;
    let databaseError: unknown;
    let descriptorError: unknown;
    try {
      database.close();
    } catch (error) {
      databaseError = error;
    }
    try {
      closeSync(this.#descriptor);
    } catch (error) {
      descriptorError = error;
    }
    if (databaseError !== undefined && descriptorError !== undefined) {
      throw new AggregateError(
        [databaseError, descriptorError],
        'Run database close failed',
        { cause: databaseError },
      );
    }
    if (databaseError !== undefined) {
      throw databaseError;
    }
    if (descriptorError !== undefined) {
      throw descriptorError;
    }
  }
}

export function openExistingDatabaseFile(
  databasePath: string,
  timeout: number,
): { readonly database: DatabaseSync; readonly file: RunDatabaseFile } {
  const descriptor = openSync(
    databasePath,
    constants.O_RDWR | constants.O_NOFOLLOW,
  );
  return openDatabaseFileFromDescriptor(databasePath, descriptor, timeout);
}

export function openDatabaseFileFromDescriptor(
  databasePath: string,
  descriptor: number,
  timeout: number,
): { readonly database: DatabaseSync; readonly file: RunDatabaseFile } {
  let database: DatabaseSync | undefined;
  try {
    if (!fstatSync(descriptor).isFile()) {
      throw new Error('Run database path must be a regular file');
    }
    const databaseUri = `${pathToFileURL(databasePath).href}?mode=rw`;
    database = new DatabaseSync(databaseUri, { timeout });
    return {
      database,
      file: new RunDatabaseFile(descriptor),
    };
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    if (database?.isOpen === true) {
      try {
        database.close();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    try {
      closeSync(descriptor);
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (cleanupErrors.length !== 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    }
    throw error;
  }
}
