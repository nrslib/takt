import { describe, expect, it } from 'vitest';
import {
  verifyDeepSeekManagedLock,
  verifyDeepSeekPackAssets,
  verifyStartupBundleLock,
} from '../../scripts/verify-deepseek-sdk-lock.mjs';

const dependencies = { '@modelcontextprotocol/sdk': '1.32.1', ink: '7.1.1', react: '19.2.8', 'update-notifier': '7.3.1' };

/** Build independent manifest/lock copies so each startup-bundle rejection test can mutate its own fixture. */
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

const SDK_VERSION = '0.2.1-alpha.2';
const CORDIS_VERSION = '4.0.5-alpha.1';
const STALE_VERSION = '0.0.0-stale';
const sdkDependencies = {
  '@deepseek-ai/cordis': CORDIS_VERSION,
  '@deepseek-ai/dsh': SDK_VERSION,
  '@deepseek-ai/dsh-llm': SDK_VERSION,
  '@deepseek-ai/dsh-scope': SDK_VERSION,
  '@deepseek-ai/dsh-sdk-client': SDK_VERSION,
  '@deepseek-ai/dsh-sdk-protocol': SDK_VERSION,
  '@deepseek-ai/dsh-session': SDK_VERSION,
  '@deepseek-ai/dsh-subagent': SDK_VERSION,
};

/** Build a consistent pinned SDK graph with independent root/managed lock entries for stale-version tests. */
function createDeepSeekFixture(): {
  root: Parameters<typeof verifyDeepSeekManagedLock>[0];
  rootLock: Parameters<typeof verifyDeepSeekManagedLock>[1];
  managed: Parameters<typeof verifyDeepSeekManagedLock>[2];
  lock: Parameters<typeof verifyDeepSeekManagedLock>[3];
  constants: string;
} {
  const rootLockPackages = Object.fromEntries(Object.entries(sdkDependencies).map(([name, version]) => [
    `node_modules/${name}`,
    { version },
  ]));
  const managedDependencies = {
    ...sdkDependencies,
    '@deepseek-ai/libreoffice-kit': '0.1.5',
  };
  const managedLockPackages = Object.fromEntries(Object.entries(managedDependencies).map(([name, version]) => [
    `node_modules/${name}`,
    { version },
  ]));

  return {
    root: {
      dependencies: {},
      bundleDependencies: [],
      devDependencies: { ...sdkDependencies },
      files: ['managed/deepseek-harness/'],
    },
    rootLock: {
      packages: {
        '': { devDependencies: { ...sdkDependencies } },
        ...rootLockPackages,
      },
    },
    managed: {
      dependencies: managedDependencies,
      overrides: { fflate: '0.8.3' },
    },
    lock: {
      packages: {
        '': { dependencies: { ...managedDependencies } },
        ...managedLockPackages,
        'node_modules/fflate': { version: '0.8.3' },
        'node_modules/@deepseek-ai/dsh-sdk-client': {
          version: SDK_VERSION,
          peerDependencies: {
            '@deepseek-ai/cordis': '~4.0.5-alpha.1',
            '@deepseek-ai/dsh-llm': SDK_VERSION,
            '@deepseek-ai/dsh-sdk-protocol': SDK_VERSION,
            '@deepseek-ai/dsh-session': SDK_VERSION,
          },
        },
      },
    },
    constants: `DEEPSEEK_HARNESS_SDK_VERSION = '${SDK_VERSION}'\nDEEPSEEK_HARNESS_RUNTIME_VERSION = '${SDK_VERSION}'`,
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
    const assets = ['package.json', 'package-lock.json'].map((name) => ({
      path: `managed/deepseek-harness/${name}`,
    }));
    const bundles = manifest.bundleDependencies.map((name) => ({ path: `node_modules/${name}/package.json` }));
    expect(() => verifyDeepSeekPackAssets([...assets, ...bundles], manifest)).not.toThrow();
    for (const file of [...assets, ...bundles]) {
      expect(() => verifyDeepSeekPackAssets([...assets, ...bundles].filter((entry) => entry !== file), manifest)).toThrow();
    }
  });
});

describe('managed DeepSeek npm dependency graph', () => {
  it.each(['@deepseek-ai/dsh', '@deepseek-ai/dsh-sdk-client'])(
    'rejects %s declared as an optional production dependency',
    (name) => {
      const fixture = createDeepSeekFixture();
      fixture.root.optionalDependencies = { [name]: SDK_VERSION };

      expect(() => verifyDeepSeekManagedLock(
        fixture.root,
        fixture.rootLock,
        fixture.managed,
        fixture.lock,
        fixture.constants,
      )).toThrow('without production DeepSeek dependencies');
    },
  );

  it('accepts unrelated optional dependencies while keeping DeepSeek development-only', () => {
    const fixture = createDeepSeekFixture();
    fixture.root.optionalDependencies = { fflate: '0.8.3' };

    expect(() => verifyDeepSeekManagedLock(
      fixture.root,
      fixture.rootLock,
      fixture.managed,
      fixture.lock,
      fixture.constants,
    )).not.toThrow();
  });

  it.each([
    ['root lock manifest entry', (fixture: ReturnType<typeof createDeepSeekFixture>) => {
      fixture.rootLock.packages['']!.devDependencies!['@deepseek-ai/dsh-sdk-client'] = STALE_VERSION;
    }],
    ['root lock package resolution', (fixture: ReturnType<typeof createDeepSeekFixture>) => {
      fixture.rootLock.packages['node_modules/@deepseek-ai/dsh-sdk-client']!.version = STALE_VERSION;
    }],
  ])('rejects a stale %s', (_description, makeStale) => {
    const fixture = createDeepSeekFixture();
    const verify = (): void => verifyDeepSeekManagedLock(
      fixture.root,
      fixture.rootLock,
      fixture.managed,
      fixture.lock,
      fixture.constants,
    );

    expect(verify).not.toThrow();
    makeStale(fixture);
    expect(verify).toThrow();
  });
});
