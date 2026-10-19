import type {
  DeepSeekHarnessGitPluginOption,
  DeepSeekHarnessPluginOption,
} from '../../core/models/workflow-provider-options.js';
import { resolveDeepSeekHarnessGitPlugins } from './git-plugin.js';
import {
  resolveDeepSeekHarnessNpmPlugins,
} from './npm-plugin.js';
import type { DeepSeekHarnessPluginResolution } from './plugin-types.js';

export interface ResolvedDeepSeekHarnessPlugins extends DeepSeekHarnessPluginResolution {
  npmPluginEntrypoints: string[];
}

/** Select npm entries while retaining Git options for the existing Git resolver. */
function isNpmPlugin(plugin: DeepSeekHarnessPluginOption): boolean {
  return typeof plugin === 'string' || plugin.source.startsWith('npm:');
}

/** Resolve trusted Git and npm plugins in configuration order and jointly own their cleanup. */
export async function resolveDeepSeekHarnessPlugins(
  options: readonly DeepSeekHarnessPluginOption[] | undefined,
  signal?: AbortSignal,
): Promise<ResolvedDeepSeekHarnessPlugins> {
  if (options === undefined || options.length === 0) {
    return { plugins: [], npmPluginEntrypoints: [], cleanupPaths: [], dispose: async () => {} };
  }

  const npmOptions = options.filter(isNpmPlugin);
  const gitOptions: DeepSeekHarnessGitPluginOption[] = [];
  for (const plugin of options) {
    if (typeof plugin === 'string' || plugin.source.startsWith('npm:')) continue;
    if (plugin.id === undefined) throw new Error('DeepSeek Harness Git plugin requires an id');
    gitOptions.push(plugin as DeepSeekHarnessGitPluginOption);
  }
  const gitResolution = await resolveDeepSeekHarnessGitPlugins(gitOptions, signal);
  try {
    const npmResolution = await resolveDeepSeekHarnessNpmPlugins(npmOptions, signal);
    let gitIndex = 0;
    let npmIndex = 0;
    const plugins = options.map((plugin) => {
      const resolved = isNpmPlugin(plugin)
        ? npmResolution.plugins[npmIndex++]
        : gitResolution.plugins[gitIndex++];
      if (resolved === undefined) throw new Error('DeepSeek Harness plugin resolution lost an entry');
      return resolved;
    });
    let disposed = false;
    return {
      plugins,
      npmPluginEntrypoints: npmResolution.npmPluginEntrypoints,
      cleanupPaths: [...gitResolution.cleanupPaths, ...npmResolution.cleanupPaths],
      /** Dispose both resolver installations without marking failed cleanup as complete. */
      dispose: async (): Promise<void> => {
        if (disposed) return;
        await Promise.all([gitResolution.dispose(), npmResolution.dispose()]);
        disposed = true;
      },
    };
  } catch (error) {
    await gitResolution.dispose();
    throw error;
  }
}
