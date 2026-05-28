import * as fs from 'node:fs';

function buildMissingTaskSpecError(sourceOrderPath: string): Error {
  return new Error(`Task spec file is missing: ${sourceOrderPath}`);
}

function buildInvalidTaskSpecError(sourceOrderPath: string): Error {
  return new Error(`Task spec file must be a regular file: ${sourceOrderPath}`);
}

export function readTaskSpecFile(sourceOrderPath: string): string {
  let fileDescriptor: number | undefined;
  try {
    const sourceStats = fs.lstatSync(sourceOrderPath);
    if (!sourceStats.isFile()) {
      throw buildInvalidTaskSpecError(sourceOrderPath);
    }

    fileDescriptor = fs.openSync(sourceOrderPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const descriptorStats = fs.fstatSync(fileDescriptor);
    if (!descriptorStats.isFile()) {
      throw buildInvalidTaskSpecError(sourceOrderPath);
    }

    return fs.readFileSync(fileDescriptor, 'utf-8');
  } catch (error) {
    const errorCode = (error as NodeJS.ErrnoException).code;
    if (errorCode === 'ENOENT') {
      throw buildMissingTaskSpecError(sourceOrderPath);
    }
    if (errorCode === 'ELOOP') {
      throw buildInvalidTaskSpecError(sourceOrderPath);
    }
    throw error;
  } finally {
    if (fileDescriptor !== undefined) {
      fs.closeSync(fileDescriptor);
    }
  }
}
