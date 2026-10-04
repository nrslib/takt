import { describe, expect, it } from 'vitest';
import { prepareToolkitManifest } from '../../scripts/prepare-deepseek-publish-bundle.mjs';
import { verifyDeepSeekSdkLock, verifyDeepSeekPackInventory } from '../../scripts/verify-deepseek-sdk-lock.mjs';

const original = {
  name: '@deepseek-ai/libreoffice-kit', version: '0.1.5', license: 'MPL-2.0',
  dependencies: { fflate: '0.8.2', koffi: '3.1.1' },
};

describe('DeepSeek publish dependency bundle', () => {
  it('rejects missing SDK peer root pins even when npm marks the peer inBundle', () => {
    const dependencies: Record<string, string> = Object.fromEntries([
      'dsh', 'dsh-sdk-client', 'dsh-llm', 'dsh-session', 'dsh-sdk-protocol',
    ].map((name) => [`@deepseek-ai/${name}`, '0.2.0-rc.2']));
    dependencies['@deepseek-ai/cordis'] = '4.0.4';
    dependencies['@deepseek-ai/libreoffice-kit'] = '0.1.5';
    const manifest = { dependencies, bundleDependencies: Object.keys(dependencies) };
    const lock = { packages: {
      '': { dependencies: { ...dependencies } },
      ...Object.fromEntries(Object.entries(dependencies).map(([name, version]) => [
        `node_modules/${name}`, { version, inBundle: true },
      ])),
      'node_modules/@deepseek-ai/dsh-sdk-client': {
        version: '0.2.0-rc.2', peerDependencies: {
          '@deepseek-ai/dsh-llm': '0.2.0-rc.2', '@deepseek-ai/dsh-session': '0.2.0-rc.2',
          '@deepseek-ai/dsh-sdk-protocol': '0.2.0-rc.2', '@deepseek-ai/cordis': '~4.0.4',
        },
      },
    } };
    const constants = "DEEPSEEK_HARNESS_SDK_VERSION = '0.2.0-rc.2'; DEEPSEEK_HARNESS_RUNTIME_VERSION = '0.2.0-rc.2';";
    expect(() => verifyDeepSeekSdkLock(manifest, lock, constants)).not.toThrow();
    delete manifest.dependencies['@deepseek-ai/dsh-session'];
    expect(() => verifyDeepSeekSdkLock(manifest, lock, constants)).toThrow('explicitly pinned');
  });
  it('requires every bundled dependency in the npm pack inventory', () => {
    const manifest = { bundleDependencies: ['@deepseek-ai/dsh-session', '@deepseek-ai/libreoffice-kit'] };
    expect(() => verifyDeepSeekPackInventory(manifest, [{ path: 'node_modules/@deepseek-ai/dsh-session/package.json' }]))
      .toThrow('libreoffice-kit');
    expect(() => verifyDeepSeekPackInventory(manifest, manifest.bundleDependencies.map((name) => ({ path: `node_modules/${name}/package.json` }))))
      .not.toThrow();
  });
  it('changes only the fflate declaration and leaves the original object untouched', () => {
    const patched = prepareToolkitManifest(original, '0.8.3');
    expect(patched).toEqual({ ...original, dependencies: { ...original.dependencies, fflate: '0.8.3' } });
    expect(original.dependencies.fflate).toBe('0.8.2');
  });
  it('is idempotent', () => {
    const patched = prepareToolkitManifest(original, '0.8.3');
    expect(prepareToolkitManifest(patched, '0.8.3')).toEqual(patched);
  });
  it('refuses an unpatched installed dependency', () => {
    expect(() => prepareToolkitManifest(original, '0.8.2')).toThrow('patched fflate');
  });
  it('refuses an unreviewed upstream toolkit or dependency declaration', () => {
    expect(() => prepareToolkitManifest({ ...original, version: '0.1.6' }, '0.8.3')).toThrow('toolkit changed');
    expect(() => prepareToolkitManifest({ ...original, dependencies: { fflate: '0.9.0' } }, '0.8.3')).toThrow('declaration changed');
  });
});
