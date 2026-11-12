/* eslint-disable @typescript-eslint/no-restricted-imports, no-restricted-syntax -- React のビルド選択は daemon 起動前に同期で固定する必要がある。 */
import { createRequire } from 'node:module';

// ビルド選択だけに production を使い、ユーザーのコマンドへ継承させない。
if (process.env.NODE_ENV === undefined) {
  process.env.NODE_ENV = 'production';
  try {
    const require = createRequire(import.meta.url);
    require('react');
    require('react/jsx-runtime');

    const requireFromInk = createRequire(require.resolve('ink'));
    requireFromInk('react');
    requireFromInk('react-reconciler');
    requireFromInk('react-reconciler/constants.js');
    requireFromInk('scheduler');

    // reconciler の依存はファクトリ呼び出し時に読み込まれる。
    const requireFromReconciler = createRequire(requireFromInk.resolve('react-reconciler'));
    requireFromReconciler('react');
    requireFromReconciler('scheduler');
  } finally {
    delete process.env.NODE_ENV;
  }
}
/* eslint-enable @typescript-eslint/no-restricted-imports, no-restricted-syntax */
