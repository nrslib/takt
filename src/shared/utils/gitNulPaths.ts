/** A path in the repository whose bytes are not UTF-8, so no string can name it without changing it. */
export class NonUtf8GitPathError extends Error {}

/** Decode Git's NUL-delimited path output without changing filename bytes. */
export function parseGitNulPaths(output: Buffer, command: string): string[] {
  if (output.length === 0) {
    return [];
  }
  if (output[output.length - 1] !== 0) {
    throw new Error(`${command}: NUL-terminated output is missing its final delimiter`);
  }

  const paths: string[] = [];
  let start = 0;
  while (start < output.length) {
    const end = output.indexOf(0, start);
    if (end === start) {
      throw new Error(`${command}: NUL-terminated output contains an empty path`);
    }
    const raw = output.subarray(start, end);
    const decoded = raw.toString('utf8');
    if (!Buffer.from(decoded, 'utf8').equals(raw)) {
      throw new NonUtf8GitPathError(`${command}: repository path is not reversibly UTF-8 encoded`);
    }
    paths.push(decoded);
    start = end + 1;
  }
  return paths;
}
