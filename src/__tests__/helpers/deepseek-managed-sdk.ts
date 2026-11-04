import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type {
  ManagedDeepSeekLlm,
  ManagedDeepSeekSdk,
} from '../../infra/deepseek-harness/sdk-types.js';

export interface DeepSeekTestHarnessClient {
  initialize(params: Record<string, unknown>): Promise<unknown>;
}

export interface DeepSeekTestSdk extends ManagedDeepSeekSdk {
  HarnessClient: new (options?: Record<string, unknown>) => DeepSeekTestHarnessClient;
}

export interface DeepSeekTestModules {
  directory: string;
  sdkPath: string;
  llmPath: string;
  sdk: DeepSeekTestSdk;
  llm: ManagedDeepSeekLlm;
}

export const deepSeekTestPackageRoot = fileURLToPath(
  new URL('../../../managed/deepseek-harness/', import.meta.url),
);

export async function loadDeepSeekTestModules(
  directory = deepSeekTestPackageRoot,
): Promise<DeepSeekTestModules> {
  const requireFromPackageRoot = createRequire(join(directory, 'package.json'));
  const sdkPath = requireFromPackageRoot.resolve('@deepseek-ai/dsh-sdk-client');
  const llmPath = requireFromPackageRoot.resolve('@deepseek-ai/dsh-llm');
  const [sdk, llm] = await Promise.all([
    import(pathToFileURL(sdkPath).href) as Promise<unknown>,
    import(pathToFileURL(llmPath).href) as Promise<unknown>,
  ]);
  return {
    directory,
    sdkPath,
    llmPath,
    sdk: sdk as DeepSeekTestSdk,
    llm: llm as ManagedDeepSeekLlm,
  };
}
