/**
 * Parser for verbose tar listing output (BSD tar and GNU tar formats).
 *
 * Verbose tar (`tar tvzf`) emits one line per archive entry. The path
 * appears after the timestamp field, which differs between implementations:
 *   BSD tar (macOS):  HH:MM  path
 *   GNU tar (Linux):  HH:MM:SS  path
 */

import { extname } from 'node:path';
import { ALLOWED_EXTENSIONS } from './file-filter.js';

/**
 * Regex to extract the path from a verbose tar listing line.
 *
 * Matches both BSD (HH:MM) and GNU (HH:MM:SS) timestamp formats.
 */
const TAR_VERBOSE_PATH_RE = /\d{1,2}:\d{2}(?::\d{2})? (.+)$/;

export interface TarVerboseListing {
  /** The stripped top-level directory entry (commit SHA prefix). */
  firstDirEntry: string;
  /** Archive paths of files that pass the extension filter. */
  includePaths: string[];
}

/**
 * Parse a verbose tar listing into the top-level directory and filtered file paths.
 *
 * Skips:
 * - Symlink entries (`l` type)
 * - Directory entries (`d` type)
 * - Files with extensions not in ALLOWED_EXTENSIONS
 *
 * @param lines - Non-empty lines from `tar tvzf` output
 */
export function parseTarVerboseListing(lines: string[]): TarVerboseListing {
  let firstDirEntry = '';
  const includePaths: string[] = [];

  for (const [i, line] of lines.entries()) {
    if (!line) continue;
    const type = line[0];

    const match = TAR_VERBOSE_PATH_RE.exec(line);
    if (!match) continue;
    const pathPart = match[1];
    if (!pathPart) continue;

    const archivePath = pathPart.trim();

    if (i === 0) {
      firstDirEntry = archivePath.replace(/\/$/, '');
    }

    if (type === 'd' || type === 'l') continue;

    const basename = archivePath.split('/').pop() ?? '';
    const ext = extname(basename);
    if (!(ALLOWED_EXTENSIONS as readonly string[]).includes(ext)) continue;

    includePaths.push(archivePath);
  }

  return { firstDirEntry, includePaths };
}
