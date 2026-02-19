import { resetGlobalConfigToTemplate } from '../../infra/config/global/index.js';
import { header, info, success } from '../../shared/ui/index.js';

export async function resetConfigToDefault(): Promise<void> {
  header('Reset Config');

  const result = resetGlobalConfigToTemplate();
  success('Global config reset from builtin template.');
  info(`  config: ${result.configPath}`);
  if (result.backupPath) {
    info(`  backup: ${result.backupPath}`);
  }
}
