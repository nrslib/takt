import type { ProviderCallOptions } from '../providers/types.js';
import type { ContextWindowLimits } from '../providers/context-window.js';

// Register only model limits confirmed independently of the native catalog.
// A catalog lookup must use the normal execution server, including its MCP,
// credential, and directory settings; starting a second server here leaks it.
const registeredModelLimits: Readonly<Record<string, ContextWindowLimits>> = Object.freeze({});

export async function readOpenCodeModelContextWindow(
  options: ProviderCallOptions,
): Promise<ContextWindowLimits | undefined> {
  if (options.model === undefined) return undefined;
  return registeredModelLimits[options.model];
}
