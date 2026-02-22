/**
 * takt repertoire list — list installed repertoire packages.
 */

import { getRepertoireDir } from '../../infra/config/paths.js';
import { listPackages } from '../../features/repertoire/list.js';
import { info } from '../../shared/ui/index.js';

export async function repertoireListCommand(): Promise<void> {
  const packages = listPackages(getRepertoireDir());

  if (packages.length === 0) {
    info('インストール済みパッケージはありません');
    return;
  }

  info('📦 インストール済みパッケージ:');
  for (const pkg of packages) {
    const desc = pkg.description ? `  ${pkg.description}` : '';
    info(`  ${pkg.scope}${desc}  (${pkg.ref} ${pkg.commit})`);
  }
}
