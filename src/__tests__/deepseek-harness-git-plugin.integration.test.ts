import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createServer, type Server as HttpsServer } from 'node:https';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DeepSeekHarnessPluginResolutionError,
  resolveDeepSeekHarnessGitPlugins,
} from '../infra/deepseek-harness/git-plugin.js';
import type { DeepSeekHarnessPluginResolution } from '../infra/deepseek-harness/plugin-types.js';
import { GlobalConfigSchema, ProjectConfigSchema } from '../core/models/config-schemas.js';
import { WorkflowConfigRawSchema } from '../core/models/workflow-schemas.js';
import { normalizeProviderOptions } from '../infra/config/providerOptions.js';
import type { DeepSeekHarnessGitPluginOption } from '../core/models/workflow-provider-options.js';

let root: string;
let repository: string;
let taggedCommit: string;
let stableCommit: string;
let resolutions: DeepSeekHarnessPluginResolution[] = [];

/** Run fixture Git commands synchronously and return their trimmed output. */
function git(directory: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
}

/** Resolve a configured fixture plugin and register its temporary resources for teardown. */
async function resolve(source: string, ref?: string): Promise<DeepSeekHarnessPluginResolution> {
  const result = await resolveDeepSeekHarnessGitPlugins([{
    id: 'example-plugin',
    source,
    ...(ref === undefined ? {} : { ref }),
    config: { enabled: true },
  }]);
  resolutions.push(result);
  return result;
}

/** Wait a bounded interval for a child process to publish its lifecycle marker. */
async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await readFile(filePath);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error('Timed out waiting for the child-process marker');
}

/** Create an observable child that remains active until cancellation sends SIGTERM. */
async function createHangingExecutable(directory: string, command: string): Promise<void> {
  await writeFile(path.join(directory, command), [
    '#!/usr/bin/env node',
    "import { writeFileSync } from 'node:fs';",
    "writeFileSync(process.env.TAKT_GIT_PLUGIN_CHILD_STARTED, 'started');",
    'process.on(\'SIGTERM\', () => {',
    "  writeFileSync(process.env.TAKT_GIT_PLUGIN_CHILD_STOPPED, 'stopped');",
    '  process.exit(0);',
    '});',
    'setInterval(() => {}, 1_000);',
  ].join('\n'), { mode: 0o755 });
}

/** Delegate real Git commands but block checkout to test cancellation after cloning. */
async function createCheckoutBlockingGit(directory: string, realGit: string): Promise<void> {
  const script = [
    '#!/usr/bin/env node',
    "import { writeFileSync } from 'node:fs';",
    "import { spawnSync } from 'node:child_process';",
    'const args = process.argv.slice(2);',
    "if (args.includes('checkout')) {",
    "  writeFileSync(process.env.TAKT_GIT_PLUGIN_CHILD_STARTED, 'started');",
    '  process.on(\'SIGTERM\', () => {',
    "    writeFileSync(process.env.TAKT_GIT_PLUGIN_CHILD_STOPPED, 'stopped');",
    '    process.exit(0);',
    '  });',
    '  setInterval(() => {}, 1_000);',
    '} else {',
    `  const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' });`,
    '  if (result.error) throw result.error;',
    '  process.exit(result.status ?? 1);',
    '}',
  ].join('\n');
  await writeFile(path.join(directory, 'git'), script, { mode: 0o755 });
}

describe('DeepSeek Harness Git plugin resolution', () => {
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'takt-deepseek-git-plugin-test-'));
    repository = path.join(root, 'repository');
    await mkdir(repository);
    git(repository, 'init', '-b', 'main');
    git(repository, 'config', 'user.email', 'test@example.invalid');
    git(repository, 'config', 'user.name', 'Test');
    await writeFile(path.join(repository, 'package.json'), JSON.stringify({ name: 'test-plugin', main: 'index.js' }));
    await writeFile(path.join(repository, 'index.js'), 'export default class Plugin {}\n');
    git(repository, 'add', '.');
    git(repository, 'commit', '-m', 'initial');
    taggedCommit = git(repository, 'rev-parse', 'HEAD');
    git(repository, 'tag', 'v1.0.0');
    git(repository, 'checkout', '-b', 'stable');
    await writeFile(path.join(repository, 'index.js'), 'export default class StablePlugin {}\n');
    git(repository, 'commit', '-am', 'stable');
    stableCommit = git(repository, 'rev-parse', 'HEAD');
    git(repository, 'checkout', 'main');
  });

  afterEach(async () => {
    await Promise.all(resolutions.splice(0).map((resolution) => resolution.dispose()));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it.each(['tag', 'branch', 'commit'] as const)(
    'checks out the requested Git %s and resolves the plugin entrypoint',
    async (refKind) => {
      const ref = refKind === 'tag' ? 'v1.0.0' : refKind === 'branch' ? 'stable' : taggedCommit;
      const expected = refKind === 'branch' ? 'export default class StablePlugin {}' : 'export default class Plugin {}';
      const source = refKind === 'branch'
        ? new URL(`file://${repository}`).href
        : `git:${new URL(`file://${repository}`).href}`;
      const result = await resolve(source, ref);
      expect(result.plugins).toHaveLength(1);
      expect(result.plugins[0]).toMatchObject({ id: 'example-plugin', config: { enabled: true } });
      expect(await readFile(new URL(result.plugins[0]!.name), 'utf8')).toContain(expected);
      expect(refKind === 'branch' ? stableCommit : taggedCommit).toMatch(/^[a-f0-9]{40,64}$/u);
    },
  );

  it('warns when ref is omitted and still resolves the plugin', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await resolve(new URL(`file://${repository}`).href);
      expect(result.plugins[0]?.id).toBe('example-plugin');
      expect(warning).toHaveBeenCalledOnce();
      expect(warning.mock.calls[0]?.[0]).toContain('no ref');
    } finally {
      warning.mockRestore();
    }
  });

  it('passes trusted global Git plugin settings through normalization to the resolver', async () => {
    const source = 'https://example.test/plugin.git';
    vi.stubEnv('GIT_CONFIG_COUNT', '1');
    vi.stubEnv('GIT_CONFIG_KEY_0', `url.${pathToFileURL(repository).href}.insteadOf`);
    vi.stubEnv('GIT_CONFIG_VALUE_0', source);
    try {
      const globalConfig = GlobalConfigSchema.parse({
        provider_options: {
          deepseek_harness: {
            plugins: [{
              id: 'project-plugin',
              source,
              ref: 'v1.0.0',
              config: { enabled: true },
            }],
          },
        },
      });
      const normalized = normalizeProviderOptions(globalConfig.provider_options, {
        baseUrlTrust: 'local-loopback-only', getOrigin: () => 'global',
      });
      const plugins = normalized?.deepseekHarness?.plugins;
      expect(plugins).toEqual([{
        id: 'project-plugin',
        source,
        ref: 'v1.0.0',
        config: { enabled: true },
      }]);

      const gitPlugins = plugins?.filter((plugin): plugin is DeepSeekHarnessGitPluginOption => (
        typeof plugin !== 'string' && !plugin.source.startsWith('npm:')
      ));
      expect(gitPlugins).toEqual([{
        id: 'project-plugin',
        source,
        ref: 'v1.0.0',
        config: { enabled: true },
      }]);

      const result = await resolveDeepSeekHarnessGitPlugins(gitPlugins);
      resolutions.push(result);
      expect(result.plugins).toEqual([
        expect.objectContaining({
          id: 'project-plugin',
          config: { enabled: true },
          name: expect.stringMatching(/^file:/u),
        }),
      ]);
      expect(await readFile(new URL(result.plugins[0]!.name), 'utf8'))
        .toContain('export default class Plugin {}');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('rejects malformed project plugins and keeps workflow-level provider options unsupported', () => {
    expect(() => ProjectConfigSchema.parse({
      provider_options: {
        deepseek_harness: {
          plugins: [{
            id: 'project-plugin',
            source: 'https://example.test/plugin.git',
            unexpected: true,
          }],
        },
      },
    })).toThrow();

    expect(() => WorkflowConfigRawSchema.parse({
      name: 'workflow-provider-options',
      workflow_config: {
        provider_options: {
          deepseek_harness: {
            plugins: [{ id: 'workflow-plugin', source: 'https://example.test/plugin.git' }],
          },
        },
      },
      steps: [{ name: 'step', instruction: '{task}' }],
    })).toThrow(/runtime\.yaml/u);
  });

  it.each([
    { source: 'git:https://example.test/plugin.git', rewritePrefix: 'https://example.test/plugin.git' },
    { source: 'https://example.test/plugin.git', rewritePrefix: 'https://example.test/plugin.git' },
  ])('fetches supported remote source $source through Git', async ({ source, rewritePrefix }) => {
    vi.stubEnv('GIT_CONFIG_COUNT', '1');
    vi.stubEnv('GIT_CONFIG_KEY_0', `url.${pathToFileURL(repository).href}.insteadOf`);
    vi.stubEnv('GIT_CONFIG_VALUE_0', rewritePrefix);
    try {
      const result = await resolve(source, 'v1.0.0');
      expect(await readFile(new URL(result.plugins[0]!.name), 'utf8')).toContain('export default class Plugin {}');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    'ssh://git@example.test/team/plugin.git',
    'git@example.test:team/plugin.git',
  ])('clones SSH source %s through Git SSH transport', async (source) => {
    const sshCommand = path.join(root, 'test-ssh-command');
    const sshMarker = path.join(root, 'ssh-transport-used');
    await writeFile(sshCommand, [
      '#!/bin/sh',
      'printf used > "$TAKT_GIT_PLUGIN_SSH_MARKER"',
      'exec git-upload-pack "$TAKT_GIT_PLUGIN_SSH_REPOSITORY"',
    ].join('\n'), { mode: 0o700 });
    const emptyGitConfig = path.join(root, 'ssh-test-gitconfig');
    await writeFile(emptyGitConfig, '');
    vi.stubEnv('GIT_CONFIG_GLOBAL', emptyGitConfig);
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    vi.stubEnv('GIT_SSH_COMMAND', JSON.stringify(sshCommand));
    vi.stubEnv('TAKT_GIT_PLUGIN_SSH_MARKER', sshMarker);
    vi.stubEnv('TAKT_GIT_PLUGIN_SSH_REPOSITORY', repository);
    try {
      const result = await resolve(source, 'main');
      expect(await readFile(new URL(result.plugins[0]!.name), 'utf8')).toContain('export default class Plugin {}');
      expect(await readFile(sshMarker, 'utf8')).toBe('used');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.skipIf(process.platform === 'win32')('uses the configured Git credential helper for an authenticated HTTPS clone without logging credentials', async () => {
    const bareRepository = path.join(root, 'private-repository.git');
    execFileSync('git', ['clone', '--bare', '--', repository, bareRepository]);
    const keyPath = path.join(root, 'https-key.pem');
    const certificatePath = path.join(root, 'https-cert.pem');
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-keyout', keyPath, '-out', certificatePath, '-subj', '/CN=127.0.0.1',
    ], { stdio: 'ignore' });

    const secret = 'private-helper-secret-marker';
    const expectedAuthorization = `Basic ${Buffer.from(`git:${secret}`).toString('base64')}`;
    const gitExecutableDirectory = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
    const gitHttpBackend = path.join(gitExecutableDirectory, 'git-http-backend');
    let authenticatedRequests = 0;
    let server: HttpsServer;
    server = createServer({
      key: await readFile(keyPath),
      cert: await readFile(certificatePath),
    }, (request, response) => {
      void (async () => {
        const requestChunks: Buffer[] = [];
        for await (const chunk of request) requestChunks.push(Buffer.from(chunk));
        const requestBody = Buffer.concat(requestChunks);
        if (request.headers.authorization !== expectedAuthorization) {
          response.writeHead(401, {
            'WWW-Authenticate': 'Basic realm="private Git fixture"',
            'Content-Length': '0',
          });
          response.end();
          return;
        }
        authenticatedRequests += 1;

        const requestUrl = new URL(request.url ?? '/', 'https://127.0.0.1');
        const serverAddress = server.address();
        if (serverAddress === null || typeof serverAddress === 'string') throw new Error('HTTPS test server lost its TCP port');
        const backend = spawn(gitHttpBackend, [], {
          env: {
            ...process.env,
            GIT_EXEC_PATH: gitExecutableDirectory,
            GIT_PROJECT_ROOT: root,
            GIT_HTTP_EXPORT_ALL: '1',
            GATEWAY_INTERFACE: 'CGI/1.1',
            SERVER_PROTOCOL: 'HTTP/1.1',
            SERVER_NAME: '127.0.0.1',
            SERVER_PORT: String(serverAddress.port),
            REQUEST_METHOD: request.method,
            PATH_INFO: requestUrl.pathname,
            QUERY_STRING: requestUrl.search.slice(1),
            CONTENT_TYPE: String(request.headers['content-type'] ?? ''),
            CONTENT_LENGTH: String(requestBody.length),
            REMOTE_USER: 'git',
            HTTP_HOST: String(request.headers.host ?? ''),
            ...(request.headers['git-protocol'] === undefined
              ? {}
              : { HTTP_GIT_PROTOCOL: String(request.headers['git-protocol']) }),
          },
        });
        const backendOutput: Buffer[] = [];
        backend.stdout.on('data', (chunk: Buffer) => backendOutput.push(chunk));
        backend.stderr.resume();
        backend.on('error', () => {
          response.writeHead(500);
          response.end();
        });
        backend.on('close', () => {
          const output = Buffer.concat(backendOutput);
          const crlfSeparator = output.indexOf('\r\n\r\n');
          const lfSeparator = output.indexOf('\n\n');
          const separator = crlfSeparator === -1 ? lfSeparator : crlfSeparator;
          const separatorLength = crlfSeparator === -1 ? 2 : 4;
          if (separator === -1) {
            response.writeHead(500);
            response.end();
            return;
          }
          const headerLines = output.subarray(0, separator).toString('utf8').split(/\r?\n/u);
          let statusCode = 200;
          const responseHeaders: Record<string, string> = {};
          for (const line of headerLines) {
            const colon = line.indexOf(':');
            if (colon === -1) continue;
            const name = line.slice(0, colon);
            const value = line.slice(colon + 1).trim();
            if (name.toLowerCase() === 'status') statusCode = Number.parseInt(value, 10);
            else responseHeaders[name] = value;
          }
          response.writeHead(statusCode, responseHeaders);
          response.end(output.subarray(separator + separatorLength));
        });
        backend.stdin.end(requestBody);
      })().catch(() => {
        response.writeHead(500);
        response.end();
      });
    });
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('HTTPS test server did not bind to a TCP port');

    const helperPath = path.join(root, 'git-credential-fixture');
    const helperMarker = path.join(root, 'credential-helper-used');
    await writeFile(helperPath, [
      '#!/bin/sh',
      'if [ "$1" = "get" ]; then',
      `  printf 'username=git\\npassword=${secret}\\n'`,
      '  printf used > "$TAKT_GIT_PLUGIN_CREDENTIAL_HELPER_MARKER"',
      'fi',
    ].join('\n'), { mode: 0o700 });
    const gitConfig = path.join(root, 'credential-helper-config');
    execFileSync('git', ['config', '--file', gitConfig, 'credential.helper', helperPath]);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('GIT_CONFIG_GLOBAL', gitConfig);
    vi.stubEnv('GIT_SSL_NO_VERIFY', 'true');
    vi.stubEnv('TAKT_GIT_PLUGIN_CREDENTIAL_HELPER_MARKER', helperMarker);
    try {
      const result = await resolve(`https://127.0.0.1:${address.port}/private-repository.git`, 'main');
      expect(await readFile(new URL(result.plugins[0]!.name), 'utf8')).toContain('export default class Plugin {}');
      expect(authenticatedRequests).toBeGreaterThan(0);
      expect(await readFile(helperMarker, 'utf8')).toBe('used');
      expect(JSON.stringify([log.mock.calls, warning.mock.calls, error.mock.calls])).not.toContain(secret);
    } finally {
      log.mockRestore();
      warning.mockRestore();
      error.mockRestore();
      vi.unstubAllEnvs();
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((closeError) => closeError === undefined ? resolveClose() : rejectClose(closeError));
      });
    }
  }, 30_000);

  it.each([
    'npm:example-plugin', 'example-plugin',
    'http://example.test/plugin.git', 'git://example.test/plugin.git',
    'git:http://example.test/plugin.git', 'git:git://example.test/plugin.git',
    'HTTP://example.test/plugin.git', 'GIT://example.test/plugin.git',
  ])('rejects unsupported or plaintext source %s before allocating a clone', async (source) => {
    const directoriesBefore = (await readdir(tmpdir())).filter((entry) => entry.startsWith('takt-deepseek-plugin-'));
    const binDirectory = path.join(root, 'unsupported-source-bin');
    const marker = path.join(binDirectory, 'git-started');
    await mkdir(binDirectory, { recursive: true });
    await rm(marker, { force: true });
    await writeFile(path.join(binDirectory, 'git'), [
      '#!/usr/bin/env node',
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(marker)}, 'started');`,
      'process.exit(1);',
    ].join('\n'), { mode: 0o755 });
    vi.stubEnv('PATH', `${binDirectory}${path.delimiter}${process.env.PATH ?? ''}`);
    try {
      await expect(resolveDeepSeekHarnessGitPlugins([{ id: 'unsupported-source', source }]))
        .rejects.toThrow('DeepSeek Harness plugin source must be a Git HTTPS or SSH source');
      await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await readdir(tmpdir())).filter((entry) => entry.startsWith('takt-deepseek-plugin-')))
        .toEqual(directoriesBefore);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.skipIf(process.platform === 'win32').each([undefined, 'ssh -o CustomOption=fixture'])(
    'disables Git and SSH prompts while preserving custom SSH command %s',
    async (sshCommand) => {
      const binDirectory = path.join(root, `noninteractive-git-${sshCommand === undefined ? 'default' : 'custom'}`);
      const marker = path.join(binDirectory, 'environment.jsonl');
      const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
      await mkdir(binDirectory);
      await writeFile(path.join(binDirectory, 'git'), [
        '#!/usr/bin/env node',
        "import { appendFileSync } from 'node:fs';",
        "import { spawnSync } from 'node:child_process';",
        'const args = process.argv.slice(2);',
        `appendFileSync(${JSON.stringify(marker)}, JSON.stringify({ args,`,
        '  prompt: process.env.GIT_TERMINAL_PROMPT,',
        '  gitAskpass: process.env.GIT_ASKPASS, sshAskpass: process.env.SSH_ASKPASS,',
        "  sshCommand: process.env.GIT_SSH_COMMAND, inherited: process.env.TAKT_GIT_PLUGIN_INHERITED,",
        "}) + '\\n');",
        `const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' });`,
        'if (result.error) throw result.error;',
        'process.exit(result.status ?? 1);',
      ].join('\n'), { mode: 0o755 });
      vi.stubEnv('PATH', `${binDirectory}${path.delimiter}${process.env.PATH ?? ''}`);
      vi.stubEnv('GIT_TERMINAL_PROMPT', '1');
      vi.stubEnv('GIT_ASKPASS', 'must-not-prompt');
      vi.stubEnv('SSH_ASKPASS', 'must-not-prompt');
      vi.stubEnv('GIT_SSH', undefined);
      vi.stubEnv('GIT_SSH_COMMAND', sshCommand);
      vi.stubEnv('TAKT_GIT_PLUGIN_INHERITED', 'preserved');
      try {
        await resolve(pathToFileURL(repository).href, 'main');
        const invocations = (await readFile(marker, 'utf8')).trim().split('\n')
          .map((line) => JSON.parse(line) as { args: string[]; [key: string]: unknown });
        expect(invocations.some(({ args }) => args.includes('clone'))).toBe(true);
        expect(invocations.some(({ args }) => args.includes('rev-parse'))).toBe(true);
        expect(invocations.some(({ args }) => args.includes('checkout'))).toBe(true);
        for (const invocation of invocations) {
          expect(invocation).toMatchObject({
            prompt: '0', gitAskpass: '', sshAskpass: '', inherited: 'preserved',
            sshCommand: sshCommand ?? 'ssh -o BatchMode=yes',
          });
        }
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it('does not execute Git attribute filters configured by the user during checkout', async () => {
    const filterRepository = path.join(root, 'filter-repository');
    await mkdir(filterRepository);
    git(filterRepository, 'init', '-b', 'main');
    git(filterRepository, 'config', 'user.email', 'test@example.invalid');
    git(filterRepository, 'config', 'user.name', 'Test');
    await writeFile(path.join(filterRepository, 'package.json'), JSON.stringify({ name: 'filter-plugin', main: 'index.js' }));
    await writeFile(path.join(filterRepository, 'index.js'), 'export default class Plugin {}\n');
    await writeFile(path.join(filterRepository, '.gitattributes'), 'count-filtered.txt filter=count-filter\nglobal-filtered.txt filter=global-filter\n');
    await writeFile(path.join(filterRepository, 'count-filtered.txt'), 'count-filter input');
    await writeFile(path.join(filterRepository, 'global-filtered.txt'), 'global-filter input');
    git(filterRepository, 'add', '.');
    git(filterRepository, 'commit', '-m', 'plugin with filters');

    const countFilterMarker = path.join(root, 'count-filter-executed');
    const globalFilterMarker = path.join(root, 'global-filter-executed');
    const commandFor = (marker: string): string => {
      const script = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');process.stdin.pipe(process.stdout);`;
      return `node -e ${JSON.stringify(script)}`;
    };
    const globalConfig = path.join(root, 'test-gitconfig');
    execFileSync('git', ['config', '--file', globalConfig, 'filter.global-filter.smudge', commandFor(globalFilterMarker)]);
    const countFilterCommand = commandFor(countFilterMarker);
    vi.stubEnv('GIT_CONFIG_COUNT', '1');
    vi.stubEnv('GIT_CONFIG_KEY_0', 'filter.count-filter.smudge');
    vi.stubEnv('GIT_CONFIG_VALUE_0', countFilterCommand);
    vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig);
    try {
      const result = await resolve(pathToFileURL(filterRepository).href, 'main');
      expect(await readFile(new URL(result.plugins[0]!.name), 'utf8')).toContain('export default class Plugin {}');
      await expect(readFile(countFilterMarker)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(globalFilterMarker)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('rejects credential-bearing source before cloning without exposing the secret', async () => {
    const secret = 'private-token-marker';
    const directoriesBefore = (await readdir(tmpdir())).filter((entry) => entry.startsWith('takt-deepseek-plugin-'));
    const fakeGitDirectory = path.join(root, 'credential-rejection-bin');
    const gitStartedMarker = path.join(root, 'credential-rejection-git-started');
    await mkdir(fakeGitDirectory);
    await writeFile(path.join(fakeGitDirectory, 'git'), [
      '#!/bin/sh',
      'printf started > "$TAKT_GIT_PLUGIN_GIT_MARKER"',
      'exit 1',
    ].join('\n'), { mode: 0o700 });
    vi.stubEnv('PATH', `${fakeGitDirectory}${path.delimiter}${process.env.PATH ?? ''}`);
    vi.stubEnv('TAKT_GIT_PLUGIN_GIT_MARKER', gitStartedMarker);
    try {
      for (const source of [
        `https://example.invalid/plugin.git?auth=${secret}`,
        `https://example.invalid/plugin.git?passwd=${secret}`,
        `https://example.invalid/plugin.git?access_token=${secret}`,
        `https://user:${secret}@example.invalid/plugin.git`,
        `https://%invalid?access_token=${secret}`,
        `git:${secret}@example.invalid:team/plugin.git`,
      ]) {
        let error: unknown;
        try {
          await resolveDeepSeekHarnessGitPlugins([{ id: 'unsafe', source }]);
        } catch (caught) {
          error = caught;
        }
        expect(error).toBeInstanceOf(Error);
        expect(String(error)).not.toContain(secret);
      }
      await expect(readFile(gitStartedMarker)).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await readdir(tmpdir())).filter((entry) => entry.startsWith('takt-deepseek-plugin-')))
        .toEqual(directoriesBefore);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    'git:https://example.test/plugin.git',
    'https://example.test/plugin.git',
    'ssh://git@example.test/plugin.git',
    'git@example.test:team/plugin.git',
  ])('accepts the Git source form %s before honoring an abort', async (source) => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled before clone'));
    await expect(resolveDeepSeekHarnessGitPlugins([{
      id: 'source-form', source,
    }], controller.signal)).rejects.toThrow('cancelled before clone');
  });

  it.skipIf(process.platform === 'win32')('aborts an active Git clone and removes its temporary directory', async () => {
    const directoriesBefore = (await readdir(tmpdir())).filter((entry) => entry.startsWith('takt-deepseek-plugin-'));
    const binDirectory = path.join(root, 'hanging-git-bin');
    await mkdir(binDirectory);
    await createHangingExecutable(binDirectory, 'git');
    const startedMarker = path.join(root, 'git-child-started');
    const stoppedMarker = path.join(root, 'git-child-stopped');
    const controller = new AbortController();
    vi.stubEnv('PATH', `${binDirectory}${path.delimiter}${process.env.PATH ?? ''}`);
    vi.stubEnv('TAKT_GIT_PLUGIN_CHILD_STARTED', startedMarker);
    vi.stubEnv('TAKT_GIT_PLUGIN_CHILD_STOPPED', stoppedMarker);
    const resolving = resolveDeepSeekHarnessGitPlugins([{
      id: 'abort-clone', source: pathToFileURL(repository).href, ref: 'main',
    }], controller.signal);
    try {
      await waitForFile(startedMarker);
      controller.abort(new Error('cancelled during clone'));
      await expect(resolving).rejects.toThrow('cancelled during clone');
      expect(await readFile(stoppedMarker, 'utf8')).toBe('stopped');
      expect((await readdir(tmpdir())).filter((entry) => entry.startsWith('takt-deepseek-plugin-')))
        .toEqual(directoriesBefore);
    } finally {
      controller.abort(new Error('test cleanup'));
      await resolving.catch(() => undefined);
      vi.unstubAllEnvs();
    }
  }, 15_000);

  it.skipIf(process.platform === 'win32')('aborts an active checkout after cloning and removes its temporary directory', async () => {
    const directoriesBefore = (await readdir(tmpdir())).filter((entry) => entry.startsWith('takt-deepseek-plugin-'));
    const binDirectory = path.join(root, 'blocking-checkout-bin');
    await mkdir(binDirectory);
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    await createCheckoutBlockingGit(binDirectory, realGit);
    const startedMarker = path.join(root, 'checkout-child-started');
    const stoppedMarker = path.join(root, 'checkout-child-stopped');
    const controller = new AbortController();
    vi.stubEnv('PATH', `${binDirectory}${path.delimiter}${process.env.PATH ?? ''}`);
    vi.stubEnv('TAKT_GIT_PLUGIN_CHILD_STARTED', startedMarker);
    vi.stubEnv('TAKT_GIT_PLUGIN_CHILD_STOPPED', stoppedMarker);
    const resolving = resolveDeepSeekHarnessGitPlugins([{
      id: 'abort-checkout', source: pathToFileURL(repository).href, ref: 'main',
    }], controller.signal);
    try {
      await waitForFile(startedMarker);
      controller.abort(new Error('cancelled during checkout'));
      await expect(resolving).rejects.toThrow('cancelled during checkout');
      expect(await readFile(stoppedMarker, 'utf8')).toBe('stopped');
      expect((await readdir(tmpdir())).filter((entry) => entry.startsWith('takt-deepseek-plugin-')))
        .toEqual(directoriesBefore);
    } finally {
      controller.abort(new Error('test cleanup'));
      await resolving.catch(() => undefined);
      vi.unstubAllEnvs();
    }
  }, 15_000);

  it.skipIf(process.platform === 'win32')('aborts an active dependency install and removes its temporary directory', async () => {
    const directoriesBefore = (await readdir(tmpdir())).filter((entry) => entry.startsWith('takt-deepseek-plugin-'));
    const installRepository = path.join(root, 'abort-install-repository');
    await mkdir(installRepository);
    git(installRepository, 'init', '-b', 'main');
    git(installRepository, 'config', 'user.email', 'test@example.invalid');
    git(installRepository, 'config', 'user.name', 'Test');
    await writeFile(path.join(installRepository, 'package.json'), JSON.stringify({ name: 'abort-install-plugin', main: 'index.js' }));
    await writeFile(path.join(installRepository, 'index.js'), 'export default class Plugin {}\n');
    git(installRepository, 'add', '.');
    git(installRepository, 'commit', '-m', 'plugin for abort test');

    const binDirectory = path.join(root, 'hanging-npm-bin');
    await mkdir(binDirectory);
    await createHangingExecutable(binDirectory, 'npm');
    const startedMarker = path.join(root, 'npm-child-started');
    const stoppedMarker = path.join(root, 'npm-child-stopped');
    const controller = new AbortController();
    vi.stubEnv('PATH', `${binDirectory}${path.delimiter}${process.env.PATH ?? ''}`);
    vi.stubEnv('TAKT_GIT_PLUGIN_CHILD_STARTED', startedMarker);
    vi.stubEnv('TAKT_GIT_PLUGIN_CHILD_STOPPED', stoppedMarker);
    const resolving = resolveDeepSeekHarnessGitPlugins([{
      id: 'abort-install', source: pathToFileURL(installRepository).href, ref: 'main',
    }], controller.signal);
    try {
      await waitForFile(startedMarker);
      controller.abort(new Error('cancelled during dependency install'));
      await expect(resolving).rejects.toThrow('cancelled during dependency install');
      expect(await readFile(stoppedMarker, 'utf8')).toBe('stopped');
      expect((await readdir(tmpdir())).filter((entry) => entry.startsWith('takt-deepseek-plugin-')))
        .toEqual(directoriesBefore);
    } finally {
      controller.abort(new Error('test cleanup'));
      await resolving.catch(() => undefined);
      vi.unstubAllEnvs();
    }
  }, 15_000);

  it('distinguishes clone, checkout, dependency, and entrypoint failures and removes failed clones', async () => {
    const pluginDirectoriesBefore = (await readdir(tmpdir())).filter((entry) => entry.startsWith('takt-deepseek-plugin-'));
    const cases = [
      { source: new URL(`file://${path.join(root, 'missing-repository')}`).href, ref: undefined, stage: 'clone' },
      { source: new URL(`file://${repository}`).href, ref: 'missing-ref', stage: 'checkout' },
    ] as const;
    for (const failure of cases) {
      const resolution = resolveDeepSeekHarnessGitPlugins([{
        id: 'failure-case', source: failure.source, ...(failure.ref === undefined ? {} : { ref: failure.ref }),
      }]);
      await expect(resolution).rejects.toBeInstanceOf(DeepSeekHarnessPluginResolutionError);
      await expect(resolution).rejects.toMatchObject({ stage: failure.stage });
    }

    const invalidRepository = path.join(root, 'invalid-package');
    await mkdir(invalidRepository);
    git(invalidRepository, 'init', '-b', 'main');
    git(invalidRepository, 'config', 'user.email', 'test@example.invalid');
    git(invalidRepository, 'config', 'user.name', 'Test');
    await writeFile(path.join(invalidRepository, 'package.json'), JSON.stringify({
      name: 'dependency-failure',
      dependencies: { 'missing-dependency': 'not-a-valid-version' },
    }));
    await writeFile(path.join(invalidRepository, 'index.js'), 'export default class Plugin {}\n');
    git(invalidRepository, 'add', '.');
    git(invalidRepository, 'commit', '-m', 'invalid manifest');
    const dependencyResolution = resolveDeepSeekHarnessGitPlugins([{
      id: 'dependency-failure', source: new URL(`file://${invalidRepository}`).href,
    }]);
    await expect(dependencyResolution).rejects.toBeInstanceOf(DeepSeekHarnessPluginResolutionError);
    await expect(dependencyResolution).rejects.toMatchObject({ stage: 'dependency-install' });

    const noEntrypoint = path.join(root, 'no-entrypoint');
    await mkdir(noEntrypoint);
    git(noEntrypoint, 'init', '-b', 'main');
    git(noEntrypoint, 'config', 'user.email', 'test@example.invalid');
    git(noEntrypoint, 'config', 'user.name', 'Test');
    await writeFile(path.join(noEntrypoint, 'README.md'), 'no executable entrypoint');
    git(noEntrypoint, 'add', '.');
    git(noEntrypoint, 'commit', '-m', 'no entrypoint');
    const entrypointResolution = resolveDeepSeekHarnessGitPlugins([{
      id: 'entrypoint-failure', source: new URL(`file://${noEntrypoint}`).href,
    }]);
    await expect(entrypointResolution).rejects.toBeInstanceOf(DeepSeekHarnessPluginResolutionError);
    await expect(entrypointResolution).rejects.toMatchObject({ stage: 'entrypoint' });
    expect((await readdir(tmpdir())).filter((entry) => entry.startsWith('takt-deepseek-plugin-')))
      .toEqual(pluginDirectoriesBefore);
  });

  it('removes resolved clone directories when disposed', async () => {
    const result = await resolve(new URL(`file://${repository}`).href, 'v1.0.0');
    const entrypoint = new URL(result.plugins[0]!.name);
    const cloneDirectory = path.dirname(entrypoint.pathname);
    await result.dispose();
    await expect(readFile(entrypoint)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(import('node:fs/promises').then(({ stat }) => stat(cloneDirectory)))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });
});
