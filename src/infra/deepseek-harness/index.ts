export { callDeepSeekHarness, closeDeepSeekHarnessProcesses } from './client.js';
export {
  installManagedDeepSeekHarness,
  resolveDeepSeekHarnessManagedPaths,
  validateDeepSeekHarnessInstallation,
} from './managed-venv.js';
export type {
  DeepSeekHarnessInstallation,
  DeepSeekHarnessManagedPaths,
  InstallManagedDeepSeekHarnessOptions,
  ManagedDeepSeekHarnessInstallation,
  ValidateDeepSeekHarnessInstallationOptions,
} from './managed-venv.js';
export type { DeepSeekHarnessCallOptions } from './types.js';
