import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { loadTemplate } from '../../shared/prompts/index.js';
import { ensurePrivateDirectory, PrivateArtifactContentWriteFailedError, writeNewPrivateFileWithMode } from '../../shared/utils/private-file.js';
import { assertSafePath } from '../../shared/utils/private-path-identity.js';
import { createLogger } from '../../shared/utils/debug.js';
import type { ProviderCallOptions } from '../providers/types.js';

type CallPacketOptions = Pick<ProviderCallOptions, 'executionPhase' | 'compactionHandoffDirectory'>;
const log = createLogger('codex-call-packet');

function isUnwritable(error: unknown): boolean {
  if (error instanceof PrivateArtifactContentWriteFailedError) return true;
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'EACCES' || code === 'EPERM' || code === 'EROFS' || code === 'ENOSPC' || code === 'EDQUOT';
}

export function prepareCodexCallPacket(
  systemPrompt: string | undefined,
  prompt: string,
  options: CallPacketOptions,
): { input: string; developerInstructions: string } {
  const input = JSON.stringify({
    taktCurrentInstructions: systemPrompt ?? null,
    userInstruction: prompt,
  });
  const sessionInstructions = loadTemplate('codex_session_instructions', 'en');
  if (options.executionPhase !== 1 || options.compactionHandoffDirectory === undefined) {
    return { input, developerInstructions: sessionInstructions };
  }
  const directory = join(options.compactionHandoffDirectory, 'call-instructions');
  const path = join(directory, `${randomUUID()}.json`);
  try {
    assertSafePath(directory, true);
    ensurePrivateDirectory(directory);
    writeNewPrivateFileWithMode(path, input, 0o600);
  } catch (error) {
    if (!isUnwritable(error)) throw error;
    log.warn('Phase 1 call artifact unavailable; continuing with inline instructions', {
      path, reason: error instanceof Error ? error.message : String(error),
    });
    return { input, developerInstructions: sessionInstructions };
  }
  return {
    input,
    developerInstructions: `${sessionInstructions}\n\nCurrent call artifact: \`${path}\`. This private immutable file contains the complete JSON input for this Phase 1 call. If context is compacted or the current assignment is unclear, read this exact file and follow its current instructions and task. Use the progress notes location in that input for the latest saved progress. Do not reconstruct the current assignment from session history or report indexes.`,
  };
}
