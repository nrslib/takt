import { describe, expect, it } from 'vitest';
import {
  verifyDeepSeekManagedLock,
  verifyDeepSeekPackAssets,
  verifyStartupBundleLock,
} from '../../scripts/verify-deepseek-sdk-lock.mjs';

const dependencies = { '@modelcontextprotocol/sdk': '1.32.1', ink: '7.1.1', react: '19.2.8', '@informalsystems/quint': '0.32.0', 'wrap-ansi': '10.0.2' };
const quint = { dependencies: { 'adm-zip': '^0.6.1' } };

/** Build independent manifest/lock copies so each startup-bundle rejection test can mutate its own fixture. */
function createFixture() {
  return {
    manifest: { dependencies: { ...dependencies }, bundleDependencies: Object.keys(dependencies), overrides: { 'adm-zip': '^0.6.1' } },
    lock: { packages: {
      '': { dependencies: { ...dependencies } },
      'node_modules/adm-zip': { version: '0.6.1' },
      ...Object.fromEntries(Object.entries(dependencies).map(([name, version]) => [
        `node_modules/${name}`, { version, inBundle: true },
      ])),
    } },
  };
}

const SDK_VERSION = '0.2.1-rc.3';
const CORDIS_VERSION = '4.0.5';
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
    '@deepseek-ai/cordis-plugin-group': '1.0.5',
    '@deepseek-ai/dsh-sandbox': SDK_VERSION,
    '@deepseek-ai/libreoffice-kit': '0.1.5',
  };
  const managedLockPackages = Object.fromEntries(Object.entries(managedDependencies).map(([name, version]) => [
    `node_modules/${name}`,
    { version },
  ]));
  managedLockPackages['node_modules/@deepseek-ai/cordis-plugin-loader'] = { version: '1.0.6' };

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
            '@deepseek-ai/cordis': '~4.0.5',
            '@deepseek-ai/dsh-llm': SDK_VERSION,
            '@deepseek-ai/dsh-sdk-protocol': SDK_VERSION,
            '@deepseek-ai/dsh-session': SDK_VERSION,
          },
        },
        'node_modules/@deepseek-ai/cordis-plugin-group': {
          version: '1.0.5',
          peerDependencies: {
            '@deepseek-ai/cordis': '~4.0.5',
            '@deepseek-ai/cordis-plugin-loader': '~1.0.6',
          },
        },
        'node_modules/@deepseek-ai/dsh-sandbox': {
          version: SDK_VERSION,
          peerDependencies: {
            '@deepseek-ai/cordis': '~4.0.5',
            '@deepseek-ai/dsh-llm': SDK_VERSION,
            '@deepseek-ai/dsh-session': SDK_VERSION,
          },
        },
      },
    },
    constants: `DEEPSEEK_HARNESS_SDK_VERSION = '${SDK_VERSION}'\nDEEPSEEK_HARNESS_RUNTIME_VERSION = '${SDK_VERSION}'`,
  };
}

describe('CLI startup publish dependency bundle', () => {
  it('rejects a pristine Quint manifest that does not accept the shipped adm-zip', () => {
    const { manifest, lock } = createFixture();
    expect(() => verifyStartupBundleLock(manifest, lock, quint)).not.toThrow();
    expect(() => verifyStartupBundleLock(manifest, lock, {
      dependencies: { 'adm-zip': '^0.5.16' },
    })).toThrow();
  });

  it('rejects an adm-zip resolution outside the bundled Quint dependency range', () => {
    const { manifest, lock } = createFixture();
    expect(() => verifyStartupBundleLock(manifest, lock, quint)).not.toThrow();
    lock.packages['node_modules/adm-zip'].version = '0.5.16';
    expect(() => verifyStartupBundleLock(manifest, lock, quint)).toThrow();
  });

  it('accepts pinned and bundled startup dependencies', () => {
    const { manifest, lock } = createFixture();
    expect(() => verifyStartupBundleLock(manifest, lock, quint)).not.toThrow();
  });

  it.each([
    ['update-notifier', '7.3.1'],
    ['boxen', '8.0.1'],
    ['wrap-ansi', '9.0.2'],
    ['widest-line', '5.0.0'],
  ])('rejects the removed transitive dependency %s@%s', (name, version) => {
    const { manifest, lock } = createFixture();
    expect(() => verifyStartupBundleLock(manifest, lock, quint)).not.toThrow();
    Object.assign(lock.packages, { [`node_modules/transitive/node_modules/${name}`]: { version, inBundle: true } });
    expect(() => verifyStartupBundleLock(manifest, lock, quint)).toThrow();
  });

  it.each(Object.entries(dependencies))('rejects missing bundle declarations and unpinned versions for %s', (name, version) => {
    const { manifest, lock } = createFixture();
    manifest.bundleDependencies = manifest.bundleDependencies.filter((bundled) => bundled !== name);
    expect(() => verifyStartupBundleLock(manifest, lock, quint)).toThrow(name);
    manifest.bundleDependencies.push(name);
    Object.assign(manifest.dependencies, { [name]: `^${version}` });
    expect(() => verifyStartupBundleLock(manifest, lock, quint)).toThrow(name);
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

  it('rejects a Cordis pin other than 4.0.5 in the root and managed SDK graphs', () => {
    const fixture = createDeepSeekFixture();
    const staleVersion = '4.0.5-alpha.1';
    fixture.root.devDependencies['@deepseek-ai/cordis'] = staleVersion;
    fixture.rootLock.packages['']!.devDependencies!['@deepseek-ai/cordis'] = staleVersion;
    fixture.rootLock.packages['node_modules/@deepseek-ai/cordis']!.version = staleVersion;
    fixture.managed.dependencies['@deepseek-ai/cordis'] = staleVersion;
    fixture.lock.packages['']!.dependencies!['@deepseek-ai/cordis'] = staleVersion;
    fixture.lock.packages['node_modules/@deepseek-ai/cordis']!.version = staleVersion;

    expect(() => verifyDeepSeekManagedLock(
      fixture.root,
      fixture.rootLock,
      fixture.managed,
      fixture.lock,
      fixture.constants,
    )).toThrow('@deepseek-ai/cordis must be pinned in the root and managed SDK dependency graphs');
  });

  it('rejects a managed DSH direct pin outside the pinned SDK version', () => {
    const fixture = createDeepSeekFixture();
    fixture.managed.dependencies['@deepseek-ai/dsh-sandbox'] = '0.2.1-alpha.2';
    fixture.lock.packages['']!.dependencies!['@deepseek-ai/dsh-sandbox'] = '0.2.1-alpha.2';
    fixture.lock.packages['node_modules/@deepseek-ai/dsh-sandbox']!.version = '0.2.1-alpha.2';

    expect(() => verifyDeepSeekManagedLock(
      fixture.root,
      fixture.rootLock,
      fixture.managed,
      fixture.lock,
      fixture.constants,
    )).toThrow('@deepseek-ai/dsh-sandbox must be pinned to 0.2.1-rc.3');
  });

  it('rejects a managed dependency lock with a peer outside the declared range', () => {
    const fixture = createDeepSeekFixture();
    fixture.lock.packages['node_modules/@deepseek-ai/cordis-plugin-loader']!.version = '1.0.5';

    expect(() => verifyDeepSeekManagedLock(
      fixture.root,
      fixture.rootLock,
      fixture.managed,
      fixture.lock,
      fixture.constants,
    )).toThrow('@deepseek-ai/cordis-plugin-group peer @deepseek-ai/cordis-plugin-loader@~1.0.6');
  });

  it.each([false, true])('validates a transitive peer even when optional=%s', (optional) => {
    const fixture = createDeepSeekFixture();
    fixture.lock.packages['node_modules/transitive-plugin'] = {
      version: '1.0.0', peerDependencies: { 'plugin-peer': '^2.0.0' },
      peerDependenciesMeta: { 'plugin-peer': { optional } },
    };
    fixture.lock.packages['node_modules/plugin-peer'] = { version: '1.0.0' };
    expect(() => verifyDeepSeekManagedLock(
      fixture.root, fixture.rootLock, fixture.managed, fixture.lock, fixture.constants,
    )).toThrow('transitive-plugin peer plugin-peer@^2.0.0');
  });

  it.each([false, true])('permits a missing transitive peer only when optional=%s', (optional) => {
    const fixture = createDeepSeekFixture();
    fixture.lock.packages['node_modules/transitive-plugin'] = {
      version: '1.0.0', peerDependencies: { 'missing-peer': '^2.0.0' },
      peerDependenciesMeta: { 'missing-peer': { optional } },
    };
    const verify = () => verifyDeepSeekManagedLock(
      fixture.root, fixture.rootLock, fixture.managed, fixture.lock, fixture.constants,
    );
    if (optional) expect(verify).not.toThrow();
    else expect(verify).toThrow('transitive-plugin peer missing-peer@^2.0.0');
  });

  it.each([false, true])('uses the nearest scoped nested peer rather than the root peer (compatible=%s)', (compatible) => {
    const fixture = createDeepSeekFixture();
    fixture.lock.packages['node_modules/parent/node_modules/@scope/plugin'] = {
      version: '1.0.0', peerDependencies: { '@scope/peer': '^2.0.0' },
    };
    fixture.lock.packages['node_modules/parent/node_modules/@scope/peer'] = {
      version: compatible ? '2.1.0' : '1.0.0',
    };
    fixture.lock.packages['node_modules/@scope/peer'] = { version: compatible ? '1.0.0' : '2.1.0' };
    const verify = () => verifyDeepSeekManagedLock(
      fixture.root, fixture.rootLock, fixture.managed, fixture.lock, fixture.constants,
    );
    if (compatible) expect(verify).not.toThrow();
    else expect(verify).toThrow('@scope/plugin peer @scope/peer@^2.0.0');
  });

  it('rejects a present optional peer without a version', () => {
    const fixture = createDeepSeekFixture();
    fixture.lock.packages['node_modules/transitive-plugin'] = {
      version: '1.0.0', peerDependencies: { 'plugin-peer': '^2.0.0' },
      peerDependenciesMeta: { 'plugin-peer': { optional: true } },
    };
    fixture.lock.packages['node_modules/plugin-peer'] = {};
    expect(() => verifyDeepSeekManagedLock(
      fixture.root, fixture.rootLock, fixture.managed, fixture.lock, fixture.constants,
    )).toThrow('transitive-plugin peer plugin-peer@^2.0.0');
  });

  it.each([
    ['manifest override', (fixture: ReturnType<typeof createDeepSeekFixture>) => {
      fixture.managed.overrides!.fflate = '0.8.2';
    }],
    ['managed lock resolution', (fixture: ReturnType<typeof createDeepSeekFixture>) => {
      fixture.lock.packages['node_modules/fflate']!.version = '0.8.2';
    }],
  ])('rejects an incorrect fflate 0.8.3 %s', (_description, makeInvalid) => {
    const fixture = createDeepSeekFixture();
    makeInvalid(fixture);

    expect(() => verifyDeepSeekManagedLock(
      fixture.root,
      fixture.rootLock,
      fixture.managed,
      fixture.lock,
      fixture.constants,
    )).toThrow('fflate 0.8.3');
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
