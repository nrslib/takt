import { isAbsolute, resolve } from 'node:path';
import {
  isOpenCodePathWithinReadonlyDirectories,
  normalizeOpenCodeExternalDirectories,
} from '../external-directories.js';

interface PluginInput {
  directory: string;
}

interface PluginOptions {
  readonlyDirectories?: unknown;
}

interface ToolExecuteBeforeInput {
  tool: string;
}

interface ToolExecuteBeforeOutput {
  args: Record<string, unknown>;
}

export const ReadonlyDirectoryGuard = async (
  input: PluginInput,
  options?: PluginOptions,
): Promise<{
  'tool.execute.before': (hookInput: ToolExecuteBeforeInput, output: ToolExecuteBeforeOutput) => Promise<void>;
}> => {
  const configuredDirectories = options?.readonlyDirectories;
  if (!Array.isArray(configuredDirectories)
    || configuredDirectories.length === 0
    || !configuredDirectories.every((directory): directory is string => typeof directory === 'string')) {
    throw new Error('OpenCode read-only directory guard requires configured directories');
  }
  const readonlyDirectories = normalizeOpenCodeExternalDirectories(configuredDirectories);

  return {
    'tool.execute.before': async (hookInput, output) => {
      if (hookInput.tool === 'patch' || hookInput.tool === 'apply_patch') {
        throw new Error('OpenCode patch tools are disabled when read-only directories are configured');
      }
      if (hookInput.tool !== 'edit' && hookInput.tool !== 'write') return;

      const filePath = output.args.filePath;
      if (typeof filePath !== 'string' || filePath.trim() === '') {
        throw new Error(`OpenCode ${hookInput.tool} requires a file path`);
      }
      const requestedPath = isAbsolute(filePath) ? filePath : resolve(input.directory, filePath);
      if (isOpenCodePathWithinReadonlyDirectories(requestedPath, readonlyDirectories)) {
        throw new Error(`OpenCode ${hookInput.tool} cannot modify a read-only directory: ${requestedPath}`);
      }
    },
  };
};
