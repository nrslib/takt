import { installManagedDeepSeekHarness } from '../../infra/deepseek-harness/index.js';
import { info, success } from '../../shared/ui/index.js';
import { sanitizeTerminalText } from '../../shared/utils/text.js';

export interface DeepSeekHarnessInstallCommandOptions {
  readonly pythonPath?: string;
}

export async function runDeepSeekHarnessInstallCommand(
  options: DeepSeekHarnessInstallCommandOptions,
): Promise<void> {
  const installation = await installManagedDeepSeekHarness(options);
  success(`DeepSeek Harness managed environment installed (${installation.sdkVersion})`);
  info(`  Python: ${sanitizeTerminalText(installation.pythonPath)}`);
  info(`  VENV: ${sanitizeTerminalText(installation.venvPath)}`);
  info(`  DSH_HOME: ${sanitizeTerminalText(installation.dshHomePath)}`);
}
