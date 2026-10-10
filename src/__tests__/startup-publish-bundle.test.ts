import { describe, expect, it } from 'vitest';
import { verifyDeepSeekPackAssets, verifyStartupBundleLock } from '../../scripts/verify-deepseek-sdk-lock.mjs';

const dependencies = { '@modelcontextprotocol/sdk': '1.32.1', ink: '7.1.1', react: '19.2.8' };

function createFixture() {
  return {
    manifest: { dependencies: { ...dependencies }, bundleDependencies: Object.keys(dependencies) },
    lock: { packages: {
      '': { dependencies: { ...dependencies } },
      ...Object.fromEntries(Object.entries(dependencies).map(([name, version]) => [
        `node_modules/${name}`, { version, inBundle: true },
      ])),
    } },
  };
}

describe('CLI startup publish dependency bundle', () => {
  it('accepts pinned and bundled startup dependencies', () => {
    const { manifest, lock } = createFixture();
    expect(() => verifyStartupBundleLock(manifest, lock)).not.toThrow();
  });

  it.each(Object.entries(dependencies))('rejects missing bundle declarations and unpinned versions for %s', (name, version) => {
    const { manifest, lock } = createFixture();
    manifest.bundleDependencies = manifest.bundleDependencies.filter((bundled) => bundled !== name);
    expect(() => verifyStartupBundleLock(manifest, lock)).toThrow(name);
    manifest.bundleDependencies.push(name);
    Object.assign(manifest.dependencies, { [name]: `^${version}` });
    expect(() => verifyStartupBundleLock(manifest, lock)).toThrow(name);
  });

  it('requires managed assets and every startup bundle in the npm pack inventory', () => {
    const { manifest } = createFixture();
    const assets = ['deepseek-harness', 'claude-sdk', 'codex', 'opencode', 'pi'].flatMap((provider) =>
      ['package.json', 'package-lock.json'].map((name) => ({ path: `managed/${provider}/${name}` })));
    const bundles = manifest.bundleDependencies.map((name) => ({ path: `node_modules/${name}/package.json` }));
    expect(() => verifyDeepSeekPackAssets([...assets, ...bundles], manifest)).not.toThrow();
    for (const file of [...assets, ...bundles]) {
      expect(() => verifyDeepSeekPackAssets([...assets, ...bundles].filter((entry) => entry !== file), manifest)).toThrow();
    }
  });
});
