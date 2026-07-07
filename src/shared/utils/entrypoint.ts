import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function isDirectEntrypoint(metaUrl: string, argv = process.argv): boolean {
  const entrypointArg = argv[1];
  if (entrypointArg === undefined) {
    return false;
  }

  try {
    return realpathSync(entrypointArg) === realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}
