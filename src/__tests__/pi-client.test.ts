import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  let listener: ((event: unknown) => void) | undefined;
  let promptOptions: unknown;
  let loaderOptions: unknown;
  let extensionLoadErrors: Array<{ path: string; error: string }> = [];
  let loadedExtensions: Array<{ path: string }> = [];
  let extensionLoadErrorSequence: Array<Array<{ path: string; error: string }>> = [];
  let reloadResourceLoader = async (): Promise<void> => undefined;
  let pendingProviderRegistrations: Array<{
    name: string;
    config: Record<string, unknown>;
    extensionPath: string;
  }> = [];
  let sessionSequence = 0;

  const assistantMessage = {
    role: 'assistant',
    content: [{ type: 'text', text: 'hello from pi' }],
    stopReason: 'stop',
  };

  const session = {
    sessionId: 'sdk-session-0',
    model: { provider: 'test', id: 'model' } as { provider: string; id: string } | undefined,
    messages: [],
    setActiveToolsByName: vi.fn(),
    setModel: vi.fn(async () => undefined),
    setThinkingLevel: vi.fn(),
    getAllTools: vi.fn(() => [
      { name: 'read', sourceInfo: { source: 'builtin' } },
      { name: 'grep', sourceInfo: { source: 'builtin' } },
      { name: 'find', sourceInfo: { source: 'builtin' } },
      { name: 'ls', sourceInfo: { source: 'builtin' } },
      { name: 'edit', sourceInfo: { source: 'builtin' } },
      { name: 'write', sourceInfo: { source: 'builtin' } },
      { name: 'bash', sourceInfo: { source: 'sdk' } },
      { name: 'trusted_extension_tool', sourceInfo: { source: 'npm:trusted-extension' } },
    ]),
    bindExtensions: vi.fn(async () => undefined),
    dispose: vi.fn(),
    hasExtensionHandlers: vi.fn(() => false),
    extensionRunner: { emit: vi.fn(async () => undefined) },
    subscribe: vi.fn((callback: (event: unknown) => void) => {
      listener = callback;
      return vi.fn();
    }),
    prompt: vi.fn(async (_prompt: string, options?: unknown) => {
      promptOptions = options;
      listener?.({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'hello from pi' },
      });
      listener?.({ type: 'message_end', message: assistantMessage });
    }),
    abort: vi.fn(async () => undefined),
    getLastAssistantText: vi.fn(() => 'hello from pi'),
  };

  const modelRuntime = {
    getModel: vi.fn((provider: string, modelId: string) => ({
      provider,
      id: modelId,
    })),
    getModels: vi.fn(() => [{ provider: 'test', id: 'model' }]),
    registerProvider: vi.fn(),
    registerNativeProvider: vi.fn(),
  };

  const packageManager = {
    getInstalledPath: vi.fn(() => undefined as string | undefined),
    resolveExtensionSources: vi.fn(async () => ({ extensions: [], skills: [], prompts: [], themes: [] })),
  };
  const projectPackageLookup = {
    getInstalledPath: vi.fn(() => undefined as string | undefined),
  };
  const sessionManager = {
    inMemory: vi.fn(() => ({ newSession: vi.fn() })),
  };
  const extensionResult = (errors = extensionLoadErrors) => ({
    extensions: loadedExtensions,
    errors,
    runtime: {
      pendingProviderRegistrations,
      pendingNativeProviderRegistrations: [],
      invalidate: mocks.extensionRuntimeInvalidate,
    },
  });

  return {
    session,
    modelRuntime,
    packageManager,
    projectPackageLookup,
    createAgentSession: vi.fn(async () => {
      session.sessionId = `sdk-session-${++sessionSequence}`;
      return { session, extensionsResult: extensionResult() };
    }),
    modelRuntimeCreate: vi.fn(async () => modelRuntime),
    extensionRuntimeInvalidate: vi.fn(),
    resourceLoader: vi.fn((options: unknown) => {
      loaderOptions = options;
      const errors = extensionLoadErrorSequence.shift() ?? extensionLoadErrors;
      return {
        reload: vi.fn(() => reloadResourceLoader()),
        getExtensions: vi.fn(() => extensionResult(errors)),
      };
    }),
    createBashToolDefinition: vi.fn(() => ({ name: 'bash' })),
    packageManagerConstructor: vi.fn(({ settingsManager }: { settingsManager: { projectTrusted?: boolean } }) => (
      settingsManager.projectTrusted ? projectPackageLookup : packageManager
    )),
    settingsManagerInMemory: vi.fn((_settings: unknown, options?: { projectTrusted?: boolean }) => ({
      projectTrusted: options?.projectTrusted,
    })),
    sessionManager,
    getAgentDir: vi.fn(() => path.join(tmpdir(), 'pi-agent-test')),
    getPromptOptions: () => promptOptions,
    getLoaderOptions: () => loaderOptions,
    emit: (event: unknown) => listener?.(event),
    resetTransient: () => {
      listener = undefined;
      promptOptions = undefined;
      loaderOptions = undefined;
      extensionLoadErrors = [];
      loadedExtensions = [];
      pendingProviderRegistrations = [];
      mocks.session.setActiveToolsByName.mockClear();
      mocks.session.bindExtensions.mockClear();
      mocks.session.setModel.mockClear();
      mocks.session.prompt.mockClear();
      mocks.session.abort.mockClear();
      mocks.session.dispose.mockClear();
      mocks.session.hasExtensionHandlers.mockClear();
      mocks.session.extensionRunner.emit.mockClear();
      mocks.session.getLastAssistantText.mockClear();
      mocks.createAgentSession.mockClear();
      mocks.resourceLoader.mockClear();
      mocks.extensionRuntimeInvalidate.mockClear();
      extensionLoadErrorSequence = [];
      reloadResourceLoader = async () => undefined;
      mocks.packageManagerConstructor.mockClear();
      mocks.settingsManagerInMemory.mockClear();
      mocks.packageManager.getInstalledPath.mockReset();
      mocks.packageManager.getInstalledPath.mockReturnValue(undefined);
      mocks.packageManager.resolveExtensionSources.mockClear();
      mocks.projectPackageLookup.getInstalledPath.mockReset();
      mocks.projectPackageLookup.getInstalledPath.mockReturnValue(undefined);
      mocks.modelRuntime.getModel.mockClear();
      mocks.modelRuntime.getModels.mockClear();
      mocks.modelRuntime.registerProvider.mockClear();
      mocks.modelRuntime.registerNativeProvider.mockClear();
    },
    setExtensionLoadErrors: (errors: Array<{ path: string; error: string }>) => {
      extensionLoadErrors = errors;
    },
    setLoadedExtensions: (extensions: Array<{ path: string }>) => {
      loadedExtensions = extensions;
    },
    setExtensionLoadErrorSequence: (sequence: Array<Array<{ path: string; error: string }>>) => {
      extensionLoadErrorSequence = sequence;
    },
    setReloadResourceLoader: (reload: () => Promise<void>) => {
      reloadResourceLoader = reload;
    },
    setPendingProviderRegistrations: (registrations: Array<{
      name: string;
      config: Record<string, unknown>;
      extensionPath: string;
    }>) => {
      pendingProviderRegistrations = registrations;
    },
  };
});

vi.mock('@earendil-works/pi-coding-agent', () => ({
  createBashToolDefinition: mocks.createBashToolDefinition,
  createAgentSession: mocks.createAgentSession,
  DefaultPackageManager: mocks.packageManagerConstructor,
  DefaultResourceLoader: mocks.resourceLoader,
  getAgentDir: mocks.getAgentDir,
  ModelRuntime: { create: mocks.modelRuntimeCreate },
  SessionManager: mocks.sessionManager,
  SettingsManager: { inMemory: mocks.settingsManagerInMemory },
}));

vi.mock('@earendil-works/pi-ai', () => ({
  InMemoryCredentialStore: class {
    async modify(_providerId: string, action: (current: undefined) => Promise<unknown>) {
      return action(undefined);
    }
  },
  InMemoryModelsStore: class {},
}));

import { callPi } from '../infra/pi/client.js';

function sessionOptions(id: string) {
  return {
    cwd: path.join(tmpdir(), 'takt-pi-project'),
    sessionId: id,
    model: 'test/model',
  };
}

describe('Pi SDK client', () => {
  it('streams text and returns the SDK session response', async () => {
    mocks.resetTransient();
    const events: string[] = [];
    const onActivity = vi.fn();

    const response = await callPi('worker', 'do the work', {
      ...sessionOptions('pi-sdk-success'),
      onStream: (event) => events.push(event.type),
      onActivity,
    });

    expect(response.status).toBe('done');
    expect(response.content).toBe('hello from pi');
    expect(response.sessionId).toMatch(/^sdk-session-\d+$/u);
    expect(events).toEqual(['init', 'text', 'result']);
    expect(onActivity).toHaveBeenCalledOnce();
    expect(onActivity).toHaveBeenCalledWith({ kind: 'attempt_started' });
    expect(mocks.modelRuntimeCreate).toHaveBeenCalledWith({
      credentials: expect.anything(),
      modelsPath: path.join(tmpdir(), 'pi-agent-test', 'models.json'),
      modelsStore: expect.anything(),
      allowModelNetwork: false,
      refreshOnCreate: true,
    });
    expect(mocks.settingsManagerInMemory).toHaveBeenCalledWith({}, { projectTrusted: false });
    expect(mocks.sessionManager.inMemory).toHaveBeenCalledWith(
      path.join(tmpdir(), 'takt-pi-project'),
      { id: 'pi-sdk-success' },
    );
    expect(mocks.session.bindExtensions).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'print',
      onError: expect.any(Function),
    }));
    expect(mocks.createAgentSession.mock.calls.at(-1)?.[0]).not.toHaveProperty('tools');
  });

  it('invalidates extension runtime when SDK session creation fails', async () => {
    mocks.resetTransient();
    mocks.createAgentSession.mockRejectedValueOnce(new Error('session creation failed'));

    const response = await callPi('worker', 'create the session', {
      ...sessionOptions('pi-sdk-session-creation-failure'),
    });

    expect(response.status).toBe('error');
    expect(mocks.extensionRuntimeInvalidate).toHaveBeenCalledOnce();
  });

  it('resolves npm extension sources temporarily when no user install exists', async () => {
    mocks.resetTransient();
    const temporary = {
      extensions: [{ enabled: true, path: path.join(tmpdir(), 'extension.ts') }],
      skills: [{ enabled: true, path: path.join(tmpdir(), 'SKILL.md') }],
      prompts: [],
      themes: [],
    };
    mocks.projectPackageLookup.getInstalledPath.mockImplementation(() => {
      throw new Error('project lookup failed');
    });
    mocks.packageManager.resolveExtensionSources.mockResolvedValueOnce(temporary);

    await callPi('worker', 'use the extension', {
      ...sessionOptions('pi-sdk-extension'),
      providerOptions: {
        extensions: ['npm:example-extension'],
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      },
    });

    expect(mocks.projectPackageLookup.getInstalledPath).toHaveBeenCalledWith(
      'npm:example-extension',
      'project',
    );
    expect(mocks.packageManager.getInstalledPath).toHaveBeenCalledWith(
      'npm:example-extension',
      'user',
    );
    expect(mocks.packageManager.resolveExtensionSources).toHaveBeenCalledOnce();
    expect(mocks.packageManager.resolveExtensionSources).toHaveBeenCalledWith(
      ['npm:example-extension'],
      { temporary: true },
    );
    expect(mocks.getLoaderOptions()).toMatchObject({
      additionalExtensionPaths: [path.join(tmpdir(), 'extension.ts')],
      additionalSkillPaths: [path.join(tmpdir(), 'SKILL.md')],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
  });

  it('reuses an existing user-scope npm extension without resolving the npm source', async () => {
    mocks.resetTransient();
    const userInstallPath = path.join(tmpdir(), 'pi-agent-test', 'npm', 'node_modules', 'example-extension');
    const userScope = {
      extensions: [{ enabled: true, path: path.join(tmpdir(), 'user-extension.ts') }],
      skills: [],
      prompts: [],
      themes: [],
    };
    mocks.packageManager.getInstalledPath.mockImplementation((_source, scope) => (
      scope === 'user' ? userInstallPath : undefined
    ));
    mocks.packageManager.resolveExtensionSources.mockResolvedValueOnce(userScope);

    const response = await callPi('worker', 'use the extension', {
      ...sessionOptions('pi-sdk-user-scope-extension'),
      providerOptions: {
        extensions: ['npm:example-extension'],
      },
    });

    expect(response.status).toBe('done');
    expect(mocks.projectPackageLookup.getInstalledPath).toHaveBeenCalledWith(
      'npm:example-extension',
      'project',
    );
    expect(mocks.packageManager.getInstalledPath).toHaveBeenCalledWith(
      'npm:example-extension',
      'user',
    );
    expect(mocks.packageManager.resolveExtensionSources).toHaveBeenCalledOnce();
    expect(mocks.packageManager.resolveExtensionSources).toHaveBeenCalledWith(
      [userInstallPath],
      { temporary: true },
    );
    expect(mocks.packageManager.resolveExtensionSources).not.toHaveBeenCalledWith(
      ['npm:example-extension'],
      { local: true },
    );
    expect(mocks.packageManager.resolveExtensionSources).not.toHaveBeenCalledWith(
      ['npm:example-extension'],
    );
    expect(mocks.packageManager.resolveExtensionSources).not.toHaveBeenCalledWith(
      ['npm:example-extension'],
      { temporary: true },
    );
    expect(mocks.getLoaderOptions()).toMatchObject({
      additionalExtensionPaths: [path.join(tmpdir(), 'user-extension.ts')],
    });
  });

  it('reuses an existing project-scope npm extension before checking user scope', async () => {
    mocks.resetTransient();
    const projectRoot = mkdtempSync(path.join(tmpdir(), 'takt-pi-project-relative-'));
    const relativeProjectCwd = path.relative(process.cwd(), projectRoot);
    const projectInstallPath = path.join(relativeProjectCwd, '.pi', 'npm', 'node_modules', 'example-extension');
    mkdirSync(path.resolve(projectInstallPath), { recursive: true });
    const projectScope = {
      extensions: [{ enabled: true, path: path.join(tmpdir(), 'project-extension.ts') }],
      skills: [],
      prompts: [],
      themes: [],
    };
    mocks.projectPackageLookup.getInstalledPath.mockReturnValue(projectInstallPath);
    mocks.packageManager.resolveExtensionSources.mockResolvedValueOnce(projectScope);

    try {
      const response = await callPi('worker', 'use the extension', {
        ...sessionOptions('pi-sdk-project-scope-extension'),
        cwd: relativeProjectCwd,
        providerOptions: {
          extensions: ['  npm:example-extension  '],
        },
      });

      expect(response.status).toBe('done');
      expect(mocks.projectPackageLookup.getInstalledPath).toHaveBeenCalledOnce();
      expect(mocks.projectPackageLookup.getInstalledPath).toHaveBeenCalledWith(
        'npm:example-extension',
        'project',
      );
      expect(mocks.packageManager.getInstalledPath).not.toHaveBeenCalled();
      expect(mocks.settingsManagerInMemory).toHaveBeenCalledWith({}, { projectTrusted: true });
      expect(mocks.packageManager.resolveExtensionSources).toHaveBeenCalledOnce();
      expect(mocks.packageManager.resolveExtensionSources).toHaveBeenCalledWith(
        [path.resolve(projectInstallPath)],
        { temporary: true },
      );
      expect(mocks.getLoaderOptions()).toMatchObject({
        additionalExtensionPaths: [path.join(tmpdir(), 'project-extension.ts')],
      });
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('falls through an unusable project install to an existing user install', async () => {
    mocks.resetTransient();
    const projectRoot = mkdtempSync(path.join(tmpdir(), 'takt-pi-project-empty-'));
    const projectInstallPath = path.join(projectRoot, '.pi', 'npm', 'node_modules', 'example-extension');
    mkdirSync(projectInstallPath, { recursive: true });
    const userInstallPath = path.join(tmpdir(), 'pi-agent-test', 'npm', 'node_modules', 'example-extension');
    const empty = { extensions: [], skills: [], prompts: [], themes: [] };
    const userScope = {
      extensions: [{ enabled: true, path: path.join(tmpdir(), 'user-extension.ts') }],
      skills: [],
      prompts: [],
      themes: [],
    };
    mocks.projectPackageLookup.getInstalledPath.mockReturnValue(projectInstallPath);
    mocks.packageManager.getInstalledPath.mockReturnValue(userInstallPath);
    mocks.packageManager.resolveExtensionSources
      .mockResolvedValueOnce(empty)
      .mockResolvedValueOnce(userScope);

    try {
      const response = await callPi('worker', 'use the extension', {
        ...sessionOptions('pi-sdk-project-empty-user-fallback'),
        cwd: projectRoot,
        providerOptions: { extensions: ['npm:example-extension'] },
      });

      expect(response.status).toBe('done');
      expect(mocks.packageManager.resolveExtensionSources).toHaveBeenNthCalledWith(
        1,
        [projectInstallPath],
        { temporary: true },
      );
      expect(mocks.packageManager.resolveExtensionSources).toHaveBeenNthCalledWith(
        2,
        [userInstallPath],
        { temporary: true },
      );
      expect(mocks.getLoaderOptions()).toMatchObject({
        additionalExtensionPaths: [path.join(tmpdir(), 'user-extension.ts')],
      });
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects a project package symlink whose target is outside project package storage', async () => {
    mocks.resetTransient();
    const projectRoot = mkdtempSync(path.join(tmpdir(), 'takt-pi-project-symlink-'));
    const outsideRoot = mkdtempSync(path.join(tmpdir(), 'outside-project-storage-'));
    const projectPackageRoot = path.join(projectRoot, '.pi', 'npm', 'node_modules');
    const escapedProjectPath = path.join(projectPackageRoot, 'example-extension');
    mkdirSync(projectPackageRoot, { recursive: true });
    symlinkSync(outsideRoot, escapedProjectPath, process.platform === 'win32' ? 'junction' : 'dir');
    const userInstallPath = path.join(tmpdir(), 'pi-agent-test', 'npm', 'node_modules', 'example-extension');
    const userScope = {
      extensions: [{ enabled: true, path: path.join(tmpdir(), 'user-extension.ts') }],
      skills: [],
      prompts: [],
      themes: [],
    };
    mocks.projectPackageLookup.getInstalledPath.mockReturnValue(escapedProjectPath);
    mocks.packageManager.getInstalledPath.mockReturnValue(userInstallPath);
    mocks.packageManager.resolveExtensionSources.mockResolvedValueOnce(userScope);

    try {
      const response = await callPi('worker', 'use the extension', {
        ...sessionOptions('pi-sdk-project-storage-escape'),
        cwd: projectRoot,
        providerOptions: { extensions: ['npm:example-extension'] },
      });

      expect(response.status).toBe('done');
      expect(mocks.packageManager.resolveExtensionSources).not.toHaveBeenCalledWith(
        [escapedProjectPath],
        { temporary: true },
      );
      expect(mocks.packageManager.resolveExtensionSources).toHaveBeenCalledWith(
        [userInstallPath],
        { temporary: true },
      );
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it.each([
    'npm:example-extension@1.2.3',
    'npm:example-extension@^1.0.0',
    'npm:@example/extension@latest',
  ])('resolves version-qualified npm source %s temporarily without existing-install lookup', async (source) => {
    mocks.resetTransient();
    const temporary = {
      extensions: [{ enabled: true, path: path.join(tmpdir(), 'versioned-extension.ts') }],
      skills: [],
      prompts: [],
      themes: [],
    };
    mocks.packageManager.resolveExtensionSources.mockResolvedValueOnce(temporary);

    const response = await callPi('worker', 'use the extension', {
      ...sessionOptions(`pi-sdk-versioned-${source}`),
      providerOptions: { extensions: [source] },
    });

    expect(response.status).toBe('done');
    expect(mocks.projectPackageLookup.getInstalledPath).not.toHaveBeenCalled();
    expect(mocks.packageManager.getInstalledPath).not.toHaveBeenCalled();
    expect(mocks.packageManager.resolveExtensionSources).toHaveBeenCalledWith(
      [source],
      { temporary: true },
    );
  });

  it.each(['npm:@scope/_foo', 'npm:@scope/.foo'])(
    'accepts a scoped npm package member beginning with . or _: %s',
    async (source) => {
      mocks.resetTransient();
      const temporary = {
        extensions: [{ enabled: true, path: path.join(tmpdir(), 'scoped-extension.ts') }],
        skills: [],
        prompts: [],
        themes: [],
      };
      mocks.packageManager.resolveExtensionSources.mockResolvedValueOnce(temporary);

      const response = await callPi('worker', 'use the extension', {
        ...sessionOptions(`pi-sdk-scoped-${source}`),
        providerOptions: { extensions: [source] },
      });

      expect(response.status).toBe('done');
      expect(mocks.projectPackageLookup.getInstalledPath).toHaveBeenCalledWith(source, 'project');
      expect(mocks.packageManager.getInstalledPath).toHaveBeenCalledWith(source, 'user');
      expect(mocks.packageManager.resolveExtensionSources).toHaveBeenCalledWith(
        [source],
        { temporary: true },
      );
    },
  );

  it('loads multiple successful extension sources only once', async () => {
    mocks.resetTransient();
    const firstSource = {
      extensions: [{ enabled: true, path: path.join(tmpdir(), 'first-extension.ts') }],
      skills: [],
      prompts: [],
      themes: [],
    };
    const secondSource = {
      extensions: [{ enabled: true, path: path.join(tmpdir(), 'second-extension.ts') }],
      skills: [],
      prompts: [],
      themes: [],
    };
    mocks.packageManager.resolveExtensionSources
      .mockResolvedValueOnce(firstSource)
      .mockResolvedValueOnce(secondSource);

    const response = await callPi('worker', 'use the extensions', {
      ...sessionOptions('pi-sdk-multiple-extension-sources'),
      providerOptions: { extensions: ['npm:first-extension', 'npm:second-extension'] },
    });

    expect(response.status).toBe('done');
    expect(mocks.resourceLoader).toHaveBeenCalledOnce();
    expect(mocks.extensionRuntimeInvalidate).not.toHaveBeenCalled();
    expect(mocks.getLoaderOptions()).toMatchObject({
      additionalExtensionPaths: [
        firstSource.extensions[0].path,
        secondSource.extensions[0].path,
      ],
    });
  });

  it('replaces only the failed candidate when multiple extension sources are configured', async () => {
    mocks.resetTransient();
    const projectRoot = mkdtempSync(path.join(tmpdir(), 'takt-pi-project-multiple-fallback-'));
    const projectInstallPath = path.join(projectRoot, '.pi', 'npm', 'node_modules', 'fallback-extension');
    const userInstallPath = path.join(tmpdir(), 'pi-agent-test', 'npm', 'node_modules', 'fallback-extension');
    const stablePath = path.join(tmpdir(), 'stable-extension.ts');
    const userPath = path.join(tmpdir(), 'working-user-extension.ts');
    mkdirSync(projectInstallPath, { recursive: true });
    mocks.projectPackageLookup.getInstalledPath.mockReturnValue(projectInstallPath);
    mocks.packageManager.getInstalledPath.mockReturnValue(userInstallPath);
    mocks.packageManager.resolveExtensionSources
      .mockResolvedValueOnce({
        extensions: [{ enabled: true, path: stablePath }],
        skills: [],
        prompts: [],
        themes: [],
      })
      .mockResolvedValueOnce({
        extensions: [{ enabled: true, path: projectInstallPath }],
        skills: [],
        prompts: [],
        themes: [],
      })
      .mockResolvedValueOnce({
        extensions: [{ enabled: true, path: userPath }],
        skills: [],
        prompts: [],
        themes: [],
      });
    mocks.setExtensionLoadErrorSequence([
      [{ path: projectInstallPath, error: 'missing extension entry point' }],
      [],
    ]);

    try {
      const response = await callPi('worker', 'use the extensions', {
        ...sessionOptions('pi-sdk-multiple-extension-fallback'),
        cwd: projectRoot,
        providerOptions: { extensions: ['./stable.ts', 'npm:fallback-extension'] },
      });

      expect(response.status).toBe('done');
      expect(mocks.resourceLoader).toHaveBeenCalledTimes(2);
      expect(mocks.extensionRuntimeInvalidate).toHaveBeenCalledOnce();
      expect(mocks.getLoaderOptions()).toMatchObject({
        additionalExtensionPaths: [stablePath, userPath],
      });
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it.each([
    'npm:../../../../evil',
    'npm:..\\..\\evil',
    'npm:foo/bar',
    'npm:@scope/../../evil',
    'npm:@scope/.',
    'npm:@scope/..',
    'npm:@/evil',
  ])('rejects unsafe npm package source %s before package lookup or resolution', async (source) => {
    mocks.resetTransient();

    const response = await callPi('worker', 'use the extension', {
      ...sessionOptions(`pi-sdk-unsafe-npm-${source}`),
      providerOptions: { extensions: [source] },
    });

    expect(response.status).toBe('error');
    expect(response.error).toContain('valid package name');
    expect(mocks.projectPackageLookup.getInstalledPath).not.toHaveBeenCalled();
    expect(mocks.packageManager.getInstalledPath).not.toHaveBeenCalled();
    expect(mocks.packageManager.resolveExtensionSources).not.toHaveBeenCalled();
  });

  it('falls back to temporary when an existing user-scope npm extension has no resources', async () => {
    mocks.resetTransient();
    const userInstallPath = path.join(tmpdir(), 'pi-agent-test', 'npm', 'node_modules', 'example-extension');
    const empty = { extensions: [], skills: [], prompts: [], themes: [] };
    const temporary = {
      extensions: [{ enabled: true, path: path.join(tmpdir(), 'temporary-extension.ts') }],
      skills: [],
      prompts: [],
      themes: [],
    };
    mocks.packageManager.getInstalledPath.mockImplementation((_source, scope) => (
      scope === 'user' ? userInstallPath : undefined
    ));
    mocks.packageManager.resolveExtensionSources
      .mockResolvedValueOnce(empty)
      .mockResolvedValueOnce(temporary);

    const response = await callPi('worker', 'use the extension', {
      ...sessionOptions('pi-sdk-user-empty-fallback'),
      providerOptions: {
        extensions: ['npm:example-extension'],
      },
    });

    expect(response.status).toBe('done');
    expect(mocks.packageManager.resolveExtensionSources).toHaveBeenNthCalledWith(
      1,
      [userInstallPath],
      { temporary: true },
    );
    expect(mocks.packageManager.resolveExtensionSources).toHaveBeenNthCalledWith(
      2,
      ['npm:example-extension'],
      { temporary: true },
    );
    expect(mocks.getLoaderOptions()).toMatchObject({
      additionalExtensionPaths: [path.join(tmpdir(), 'temporary-extension.ts')],
    });
  });

  it('falls back to temporary when an existing user-scope npm extension rejects', async () => {
    mocks.resetTransient();
    const userInstallPath = path.join(tmpdir(), 'pi-agent-test', 'npm', 'node_modules', 'example-extension');
    const temporary = {
      extensions: [{ enabled: true, path: path.join(tmpdir(), 'temporary-extension.ts') }],
      skills: [],
      prompts: [],
      themes: [],
    };
    mocks.packageManager.getInstalledPath.mockImplementation((_source, scope) => (
      scope === 'user' ? userInstallPath : undefined
    ));
    mocks.packageManager.resolveExtensionSources
      .mockRejectedValueOnce(new Error('user scope failed'))
      .mockResolvedValueOnce(temporary);

    const response = await callPi('worker', 'use the extension', {
      ...sessionOptions('pi-sdk-user-reject-fallback'),
      providerOptions: {
        extensions: ['npm:example-extension'],
      },
    });

    expect(response.status).toBe('done');
    expect(mocks.packageManager.resolveExtensionSources).toHaveBeenNthCalledWith(
      1,
      [userInstallPath],
      { temporary: true },
    );
    expect(mocks.packageManager.resolveExtensionSources).toHaveBeenNthCalledWith(
      2,
      ['npm:example-extension'],
      { temporary: true },
    );
    expect(mocks.getLoaderOptions()).toMatchObject({
      additionalExtensionPaths: [path.join(tmpdir(), 'temporary-extension.ts')],
    });
  });

  it('falls through an empty project package directory that the SDK reports as an extension', async () => {
    mocks.resetTransient();
    const projectRoot = mkdtempSync(path.join(tmpdir(), 'takt-pi-project-load-error-'));
    const projectInstallPath = path.join(projectRoot, '.pi', 'npm', 'node_modules', 'example-extension');
    const userInstallPath = path.join(tmpdir(), 'pi-agent-test', 'npm', 'node_modules', 'example-extension');
    mkdirSync(projectInstallPath, { recursive: true });
    const projectScope = {
      extensions: [{ enabled: true, path: projectInstallPath }],
      skills: [],
      prompts: [],
      themes: [],
    };
    const userScope = {
      extensions: [{ enabled: true, path: path.join(tmpdir(), 'working-user-extension.ts') }],
      skills: [],
      prompts: [],
      themes: [],
    };
    mocks.projectPackageLookup.getInstalledPath.mockReturnValue(projectInstallPath);
    mocks.packageManager.getInstalledPath.mockReturnValue(userInstallPath);
    mocks.packageManager.resolveExtensionSources
      .mockResolvedValueOnce(projectScope)
      .mockResolvedValueOnce(userScope);
    mocks.setExtensionLoadErrorSequence([
      [{ path: projectScope.extensions[0].path, error: 'syntax error' }],
      [],
    ]);

    try {
      const response = await callPi('worker', 'use the extension', {
        ...sessionOptions('pi-sdk-project-load-error-user-fallback'),
        cwd: projectRoot,
        providerOptions: { extensions: ['npm:example-extension'] },
      });

      expect(response.status).toBe('done');
      expect(mocks.packageManager.resolveExtensionSources).toHaveBeenNthCalledWith(
        1,
        [projectInstallPath],
        { temporary: true },
      );
      expect(mocks.packageManager.resolveExtensionSources).toHaveBeenNthCalledWith(
        2,
        [userInstallPath],
        { temporary: true },
      );
      expect(mocks.resourceLoader).toHaveBeenCalledTimes(2);
      expect(mocks.extensionRuntimeInvalidate).toHaveBeenCalledOnce();
      expect(mocks.getLoaderOptions()).toMatchObject({
        additionalExtensionPaths: [userScope.extensions[0].path],
      });
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('keeps project and user candidate failures in the final temporary resolution error', async () => {
    mocks.resetTransient();
    mocks.projectPackageLookup.getInstalledPath.mockImplementation(() => {
      throw new Error('project lookup failed at /private/tmp/secret-project');
    });
    mocks.packageManager.getInstalledPath.mockImplementation(() => {
      throw new Error('user lookup failed');
    });
    mocks.packageManager.resolveExtensionSources.mockRejectedValueOnce(
      new Error('temporary resolution failed'),
    );

    const response = await callPi('worker', 'use the extension', {
      ...sessionOptions('pi-sdk-candidate-failure-diagnostics'),
      providerOptions: { extensions: ['npm:example-extension'] },
    });

    expect(response.status).toBe('error');
    expect(response.error).toContain('project: project lookup failed at [path]');
    expect(response.error).not.toContain('/private/tmp/secret-project');
    expect(response.error).toContain('user: user lookup failed');
    expect(response.error).toContain('temporary: temporary resolution failed');
    expect(mocks.resourceLoader).not.toHaveBeenCalled();
  });

  it('keeps earlier scope failures when the temporary candidate fails to load', async () => {
    mocks.resetTransient();
    const temporaryPath = path.join(tmpdir(), 'topsecret-extension.ts');
    mocks.projectPackageLookup.getInstalledPath.mockImplementation(() => {
      throw new Error('project lookup failed token=topsecret');
    });
    mocks.packageManager.getInstalledPath.mockImplementation(() => {
      throw new Error('user lookup failed');
    });
    mocks.packageManager.resolveExtensionSources.mockResolvedValueOnce({
      extensions: [{ enabled: true, path: temporaryPath }],
      skills: [],
      prompts: [],
      themes: [],
    });
    mocks.setExtensionLoadErrors([{ path: temporaryPath, error: 'syntax error' }]);

    const response = await callPi('worker', 'use the extension', {
      ...sessionOptions('pi-sdk-candidate-load-failure-diagnostics'),
      providerOptions: { extensions: ['npm:example-extension'] },
    });

    expect(response.status).toBe('error');
    expect(response.error).toContain('project: project lookup failed token=[REDACTED]');
    expect(response.error).toContain('user: user lookup failed');
    expect(response.error).toContain('temporary: Pi extension loading failed');
    expect(response.error).not.toContain('topsecret');
    expect(response.error).not.toContain('topsecret-extension.ts');
    expect(mocks.extensionRuntimeInvalidate).toHaveBeenCalledOnce();
  });

  it('does not treat SDK conflict diagnostics as extension load failures', async () => {
    mocks.resetTransient();
    const extensionPath = path.join(tmpdir(), 'conflicting-extension.ts');
    mocks.packageManager.resolveExtensionSources.mockResolvedValueOnce({
      extensions: [{ enabled: true, path: extensionPath }],
      skills: [],
      prompts: [],
      themes: [],
    });
    mocks.setLoadedExtensions([{ path: extensionPath }]);
    mocks.setExtensionLoadErrors([{
      path: extensionPath,
      error: 'Tool "duplicate" conflicts with /private/tmp/other-extension.ts',
    }]);

    const response = await callPi('worker', 'load extension', {
      ...sessionOptions('pi-sdk-extension-conflict'),
      providerOptions: { extensions: ['./conflicting-extension.ts'] },
    });

    expect(response.status).toBe('error');
    expect(mocks.packageManager.resolveExtensionSources).toHaveBeenCalledOnce();
    expect(mocks.resourceLoader).toHaveBeenCalledOnce();
    expect(response.error).not.toContain('/private/tmp/other-extension.ts');
  });

  it('falls back to temporary when an existing user-scope npm extension has no enabled resources', async () => {
    mocks.resetTransient();
    const userInstallPath = path.join(tmpdir(), 'pi-agent-test', 'npm', 'node_modules', 'example-extension');
    const disabledOnly = {
      extensions: [{ enabled: false, path: path.join(tmpdir(), 'disabled-extension.ts') }],
      skills: [],
      prompts: [],
      themes: [],
    };
    const temporary = {
      extensions: [{ enabled: true, path: path.join(tmpdir(), 'temporary-extension.ts') }],
      skills: [],
      prompts: [],
      themes: [],
    };
    mocks.packageManager.getInstalledPath.mockImplementation((_source, scope) => (
      scope === 'user' ? userInstallPath : undefined
    ));
    mocks.packageManager.resolveExtensionSources
      .mockResolvedValueOnce(disabledOnly)
      .mockResolvedValueOnce(temporary);

    const response = await callPi('worker', 'use the extension', {
      ...sessionOptions('pi-sdk-user-disabled-fallback'),
      providerOptions: {
        extensions: ['npm:example-extension'],
      },
    });

    expect(response.status).toBe('done');
    expect(mocks.packageManager.resolveExtensionSources).toHaveBeenNthCalledWith(
      1,
      [userInstallPath],
      { temporary: true },
    );
    expect(mocks.packageManager.resolveExtensionSources).toHaveBeenNthCalledWith(
      2,
      ['npm:example-extension'],
      { temporary: true },
    );
    expect(mocks.getLoaderOptions()).toMatchObject({
      additionalExtensionPaths: [path.join(tmpdir(), 'temporary-extension.ts')],
    });
  });

  it('stops extension resolution after existing user-scope resolution aborts', async () => {
    mocks.resetTransient();
    const userInstallPath = path.join(tmpdir(), 'pi-agent-test', 'npm', 'node_modules', 'example-extension');
    const abortController = new AbortController();
    mocks.packageManager.getInstalledPath.mockImplementation((_source, scope) => (
      scope === 'user' ? userInstallPath : undefined
    ));
    mocks.packageManager.resolveExtensionSources.mockImplementationOnce(async () => {
      abortController.abort('cancelled during user-scope resolution');
      throw new Error('user scope failed');
    });

    const response = await callPi('worker', 'use the extension', {
      ...sessionOptions('pi-sdk-user-resolution-abort'),
      abortSignal: abortController.signal,
      providerOptions: {
        extensions: ['npm:example-extension'],
      },
    });

    expect(response.status).toBe('error');
    expect(response.failureCategory).toBe('external_abort');
    expect(mocks.projectPackageLookup.getInstalledPath).toHaveBeenCalledWith(
      'npm:example-extension',
      'project',
    );
    expect(mocks.packageManager.getInstalledPath).toHaveBeenCalledWith(
      'npm:example-extension',
      'user',
    );
    expect(mocks.packageManager.resolveExtensionSources).toHaveBeenCalledTimes(1);
    expect(mocks.packageManager.resolveExtensionSources).toHaveBeenNthCalledWith(
      1,
      [userInstallPath],
      { temporary: true },
    );
    expect(mocks.resourceLoader).not.toHaveBeenCalled();
    expect(mocks.createAgentSession).not.toHaveBeenCalled();
  });

  it('stops fallback when resource loading observes an abort', async () => {
    mocks.resetTransient();
    const projectRoot = mkdtempSync(path.join(tmpdir(), 'takt-pi-project-load-abort-'));
    const projectInstallPath = path.join(projectRoot, '.pi', 'npm', 'node_modules', 'example-extension');
    mkdirSync(projectInstallPath, { recursive: true });
    const abortController = new AbortController();
    mocks.projectPackageLookup.getInstalledPath.mockReturnValue(projectInstallPath);
    mocks.packageManager.resolveExtensionSources.mockResolvedValueOnce({
      extensions: [{ enabled: true, path: projectInstallPath }],
      skills: [],
      prompts: [],
      themes: [],
    });
    mocks.setReloadResourceLoader(async () => {
      abortController.abort('cancelled during resource loading');
    });

    try {
      const response = await callPi('worker', 'use the extension', {
        ...sessionOptions('pi-sdk-resource-load-abort'),
        cwd: projectRoot,
        abortSignal: abortController.signal,
        providerOptions: { extensions: ['npm:example-extension'] },
      });

      expect(response.status).toBe('error');
      expect(response.failureCategory).toBe('external_abort');
      expect(mocks.packageManager.getInstalledPath).not.toHaveBeenCalled();
      expect(mocks.extensionRuntimeInvalidate).toHaveBeenCalledOnce();
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it.each([
    { label: 'git', source: 'git:https://example.invalid/extension.git' },
    { label: 'local path', source: './local-extension.ts' },
  ])('resolves non-npm $label sources via temporary scope only', async ({ source }) => {
    mocks.resetTransient();
    const temporary = {
      extensions: [{ enabled: true, path: path.join(tmpdir(), 'temporary-extension.ts') }],
      skills: [],
      prompts: [],
      themes: [],
    };
    mocks.packageManager.resolveExtensionSources.mockResolvedValueOnce(temporary);

    const response = await callPi('worker', 'use the extension', {
      ...sessionOptions(`pi-sdk-temporary-${source}`),
      providerOptions: {
        extensions: [source],
      },
    });

    expect(response.status).toBe('done');
    expect(mocks.packageManager.resolveExtensionSources).toHaveBeenCalledOnce();
    expect(mocks.packageManager.resolveExtensionSources).toHaveBeenCalledWith(
      [source],
      { temporary: true },
    );
    expect(mocks.packageManager.resolveExtensionSources).not.toHaveBeenCalledWith(
      [source],
      { local: true },
    );
    expect(mocks.packageManager.resolveExtensionSources).not.toHaveBeenCalledWith([source]);
    expect(mocks.getLoaderOptions()).toMatchObject({
      additionalExtensionPaths: [path.join(tmpdir(), 'temporary-extension.ts')],
    });
  });

  it.each([
    { label: 'git', source: 'git:https://example.invalid/missing-extension.git' },
    { label: 'local path', source: './missing-extension.ts' },
  ])('fails closed when a non-npm $label source resolves to no resources', async ({ source }) => {
    mocks.resetTransient();
    mocks.packageManager.resolveExtensionSources.mockResolvedValueOnce({
      extensions: [],
      skills: [],
      prompts: [],
      themes: [],
    });

    const response = await callPi('worker', 'load extension', {
      ...sessionOptions(`pi-sdk-temporary-missing-${source}`),
      providerOptions: {
        extensions: [source],
      },
    });

    expect(response.status).toBe('error');
    expect(response.error).toContain('Pi extension source could not be resolved');
    expect(mocks.packageManager.resolveExtensionSources).toHaveBeenCalledOnce();
    expect(mocks.packageManager.resolveExtensionSources).toHaveBeenCalledWith(
      [source],
      { temporary: true },
    );
    expect(mocks.resourceLoader).not.toHaveBeenCalled();
  });

  it('maps read-only permissions and native image attachments to SDK options', async () => {
    mocks.resetTransient();
    const imageDir = mkdtempSync(path.join(tmpdir(), 'pi-client-image-'));
    const imagePath = path.join(imageDir, 'attachment.png');
    writeFileSync(imagePath, Buffer.from('image-data'));

    try {
      await callPi('worker', 'inspect the image', {
        ...sessionOptions('pi-sdk-image'),
        permissionMode: 'readonly',
        allowedTools: ['Read', 'Bash'],
        imageAttachments: [{ placeholder: '[Image #1]', path: imagePath }],
      });

      expect(mocks.createAgentSession.mock.calls.at(-1)?.[0]).not.toHaveProperty('tools');
      expect(mocks.session.setActiveToolsByName).toHaveBeenLastCalledWith(['read']);
      expect(mocks.getPromptOptions()).toMatchObject({
        images: [{ type: 'image', mimeType: 'image/png', data: Buffer.from('image-data').toString('base64') }],
      });
    } finally {
      rmSync(imageDir, { recursive: true, force: true });
    }
  });

  it('reapplies permissions when a cached session is resumed', async () => {
    mocks.resetTransient();

    await callPi('worker', 'edit once', {
      ...sessionOptions('pi-sdk-permission-resume'),
      permissionMode: 'edit',
    });
    await callPi('worker', 'review now', {
      ...sessionOptions('pi-sdk-permission-resume'),
      permissionMode: 'readonly',
    });

    expect(mocks.session.setActiveToolsByName.mock.calls[0]?.[0]).toEqual([
      'read',
      'grep',
      'find',
      'ls',
      'edit',
      'write',
      'bash',
    ]);
    expect(mocks.session.setActiveToolsByName).toHaveBeenLastCalledWith([
      'read',
      'grep',
      'find',
      'ls',
    ]);
  });

  it('reuses a session when equivalent provider options have different key order', async () => {
    mocks.resetTransient();

    await callPi('worker', 'first', {
      ...sessionOptions('pi-sdk-stable-provider-options'),
      providerOptions: { noSkills: true, noThemes: false },
    });
    await callPi('worker', 'second', {
      ...sessionOptions('pi-sdk-stable-provider-options'),
      providerOptions: { noThemes: false, noSkills: true },
    });

    expect(mocks.createAgentSession).toHaveBeenCalledTimes(1);
    expect(mocks.session.dispose).not.toHaveBeenCalled();
  });

  it('keeps extension tools registered and activates them only when allowed', async () => {
    mocks.resetTransient();

    await callPi('worker', 'explicit extension', {
      ...sessionOptions('pi-sdk-extension-permission'),
      permissionMode: 'edit',
      allowedTools: ['trusted_extension_tool'],
    });
    expect(mocks.session.setActiveToolsByName).toHaveBeenLastCalledWith([
      'trusted_extension_tool',
    ]);

    await callPi('worker', 'full access', {
      ...sessionOptions('pi-sdk-extension-permission'),
      permissionMode: 'full',
    });
    expect(mocks.session.setActiveToolsByName).toHaveBeenLastCalledWith([
      'read',
      'grep',
      'find',
      'ls',
      'edit',
      'write',
      'bash',
      'trusted_extension_tool',
    ]);
  });

  it('does not activate extension tools that shadow read-only builtins', async () => {
    mocks.resetTransient();
    mocks.session.getAllTools.mockReturnValueOnce([
      { name: 'read', sourceInfo: { source: 'npm:mutating-extension' } },
      { name: 'grep', sourceInfo: { source: 'npm:mutating-extension' } },
      { name: 'find', sourceInfo: { source: 'npm:mutating-extension' } },
      { name: 'ls', sourceInfo: { source: 'npm:mutating-extension' } },
    ]);

    await callPi('worker', 'review safely', {
      ...sessionOptions('pi-sdk-shadowed-read-tool'),
      permissionMode: 'edit',
      allowedTools: ['read', 'grep', 'find', 'ls'],
    });

    expect(mocks.session.setActiveToolsByName).toHaveBeenLastCalledWith([]);
  });

  it('requires builtin provenance for the readonly permission profile without an allowlist', async () => {
    mocks.resetTransient();
    mocks.session.getAllTools.mockReturnValueOnce([
      { name: 'read', sourceInfo: { source: 'npm:mutating-extension' } },
      { name: 'grep', sourceInfo: { source: 'npm:mutating-extension' } },
      { name: 'find', sourceInfo: { source: 'npm:mutating-extension' } },
      { name: 'ls', sourceInfo: { source: 'npm:mutating-extension' } },
    ]);

    await callPi('worker', 'review safely', {
      ...sessionOptions('pi-sdk-readonly-shadowed-tools'),
      permissionMode: 'readonly',
    });

    expect(mocks.session.setActiveToolsByName).toHaveBeenLastCalledWith([]);
  });

  it.each([
    'https://user:topsecret@example.invalid/extension.git',
    'git:https://user:topsecret@example.invalid/extension.git',
    'git://user:topsecret@example.invalid/extension.git',
    '  git://user:topsecret@example.invalid/extension.git',
    'git://example.invalid/extension.git?token=topsecret',
  ].map((source, index) => ({ index, source })))(
    'rejects credential-bearing extension URL $source before package resolution',
    async ({ index, source }) => {
      mocks.resetTransient();

      const response = await callPi('worker', 'load extension', {
        ...sessionOptions(`pi-sdk-extension-credential-${index}`),
        providerOptions: {
          extensions: [source],
        },
      });

      expect(response.status).toBe('error');
      expect(response.error).not.toContain('topsecret');
      expect(mocks.packageManager.resolveExtensionSources).not.toHaveBeenCalledWith(
        [source],
        expect.anything(),
      );
    },
  );

  it('fails closed when an explicitly configured extension resolves to no resources', async () => {
    mocks.resetTransient();

    const response = await callPi('worker', 'load extension', {
      ...sessionOptions('pi-sdk-extension-missing'),
      providerOptions: { extensions: ['./missing-extension.ts'] },
    });

    expect(response.status).toBe('error');
    expect(response.error).toContain('Pi extension source could not be resolved');
    expect(mocks.resourceLoader).not.toHaveBeenCalled();
  });

  it('fails when an explicitly configured extension cannot load', async () => {
    mocks.resetTransient();
    mocks.packageManager.resolveExtensionSources.mockResolvedValueOnce({
      extensions: [{ enabled: true, path: path.join(tmpdir(), 'broken.ts') }],
      skills: [],
      prompts: [],
      themes: [],
    });
    mocks.setExtensionLoadErrors([{ path: '/tmp/broken.ts', error: 'syntax error' }]);

    const response = await callPi('worker', 'load extension', {
      ...sessionOptions('pi-sdk-extension-error'),
      providerOptions: { extensions: ['./broken.ts'] },
    });

    expect(response.status).toBe('error');
    expect(response.error).toContain('Pi extension loading failed');
  });

  it('registers extension providers before constructing the SDK session', async () => {
    mocks.resetTransient();
    mocks.setPendingProviderRegistrations([{
      name: 'extension-provider',
      config: { baseUrl: 'https://example.invalid' },
      extensionPath: path.join(tmpdir(), 'provider-extension.ts'),
    }]);

    const response = await callPi('worker', 'load provider', {
      ...sessionOptions('pi-sdk-provider-registration'),
    });

    expect(response.status).toBe('done');
    expect(mocks.modelRuntime.registerProvider).toHaveBeenCalledWith(
      'extension-provider',
      { baseUrl: 'https://example.invalid' },
    );
    expect(mocks.modelRuntime.registerProvider.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.createAgentSession.mock.invocationCallOrder[0]!,
    );
  });

  it('fails closed when an extension provider registration is invalid', async () => {
    mocks.resetTransient();
    mocks.setPendingProviderRegistrations([{
      name: 'broken-provider',
      config: {},
      extensionPath: path.join(tmpdir(), 'broken-provider-extension.ts'),
    }]);
    mocks.modelRuntime.registerProvider.mockImplementationOnce(() => {
      throw new Error('invalid provider registration');
    });

    const response = await callPi('worker', 'load provider', {
      ...sessionOptions('pi-sdk-provider-registration-error'),
    });

    expect(response.status).toBe('error');
    expect(response.error).toContain('Pi extension provider registration failed');
    expect(response.error).toContain('invalid provider registration');
    expect(mocks.createAgentSession).not.toHaveBeenCalled();
  });

  it('shuts down extension handlers when startup fails', async () => {
    mocks.resetTransient();
    mocks.session.hasExtensionHandlers.mockReturnValueOnce(true);
    mocks.session.bindExtensions.mockRejectedValueOnce(new Error('startup failed'));

    const response = await callPi('worker', 'load extension', {
      ...sessionOptions('pi-sdk-extension-startup-failure'),
    });

    expect(response.status).toBe('error');
    expect(mocks.session.extensionRunner.emit).toHaveBeenCalledWith({
      type: 'session_shutdown',
      reason: 'quit',
    });
    expect(mocks.session.dispose).toHaveBeenCalledOnce();
  });

  it('resolves extension-provided models after creating and binding the session', async () => {
    mocks.resetTransient();
    const previousModel = mocks.session.model;
    mocks.session.model = undefined;
    mocks.modelRuntime.getModel.mockImplementation((provider: string, modelId: string) => ({
      provider,
      id: modelId,
    }));

    try {
      const response = await callPi('worker', 'custom model', {
        ...sessionOptions('pi-sdk-custom-model'),
        model: 'extension-provider/custom-model',
      });

      expect(response.status).toBe('done');
      expect(mocks.createAgentSession.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.modelRuntime.getModel.mock.invocationCallOrder[0]!,
      );
      expect(mocks.session.bindExtensions.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.modelRuntime.getModel.mock.invocationCallOrder[0]!,
      );
      expect(mocks.session.setModel).toHaveBeenCalledWith({
        provider: 'extension-provider',
        id: 'custom-model',
      });
    } finally {
      mocks.session.model = previousModel;
    }
  });

  it('does not fall back to a different provider for a qualified model', async () => {
    mocks.resetTransient();
    mocks.modelRuntime.getModel.mockImplementationOnce(() => undefined);
    mocks.modelRuntime.getModels.mockImplementationOnce(() => [{
      provider: 'other-provider',
      id: 'shared-model',
    }]);

    const response = await callPi('worker', 'use exact provider', {
      ...sessionOptions('pi-sdk-qualified-model'),
      model: 'requested-provider/shared-model',
    });

    expect(response.status).toBe('error');
    expect(response.error).toContain('Pi model "requested-provider/shared-model" was not found');
    expect(mocks.session.setModel).not.toHaveBeenCalledWith({
      provider: 'other-provider',
      id: 'shared-model',
    });
  });

  it('emits only new bytes from cumulative tool output snapshots', async () => {
    mocks.resetTransient();
    const output: string[] = [];
    mocks.session.prompt.mockImplementationOnce(async () => {
      mocks.emit({
        type: 'tool_execution_update',
        toolCallId: 'tool-1',
        toolName: 'bash',
        partialResult: { content: [{ type: 'text', text: 'first' }] },
      });
      mocks.emit({
        type: 'tool_execution_update',
        toolCallId: 'tool-1',
        toolName: 'bash',
        partialResult: { content: [{ type: 'text', text: 'first second' }] },
      });
      mocks.emit({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'done' }],
          stopReason: 'stop',
        },
      });
    });

    const response = await callPi('worker', 'stream tool output', {
      ...sessionOptions('pi-sdk-partial-output'),
      onStream: (event) => {
        if (event.type === 'tool_output') output.push(event.data.output);
      },
    });

    expect(response.status).toBe('done');
    expect(output).toEqual(['first', ' second']);
  });

  it('preserves streamed assistant text when final assistant messages have no text', async () => {
    mocks.resetTransient();
    mocks.session.prompt.mockImplementationOnce(async () => {
      mocks.emit({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'answer before tool call' },
      });
      mocks.emit({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [],
          stopReason: 'stop',
        },
      });
      mocks.emit({
        type: 'agent_end',
        messages: [{ role: 'assistant', content: [], stopReason: 'stop' }],
      });
    });

    const response = await callPi('worker', 'stream before a tool-only message', {
      ...sessionOptions('pi-sdk-empty-final-message'),
    });

    expect(response.status).toBe('done');
    expect(response.content).toBe('answer before tool call');
  });

  it('does not reuse an assistant response from a previous turn', async () => {
    mocks.resetTransient();
    mocks.session.prompt.mockImplementationOnce(async () => undefined);

    const response = await callPi('worker', '/handled-without-message', {
      ...sessionOptions('pi-sdk-empty-current-turn'),
    });

    expect(response.status).toBe('error');
    expect(response.error).toContain('Pi SDK returned no assistant text');
    expect(mocks.session.getLastAssistantText).not.toHaveBeenCalled();
  });

  it('serializes concurrent calls that reuse one SDK session', async () => {
    mocks.resetTransient();
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    mocks.session.prompt.mockImplementationOnce(async () => {
      markFirstStarted();
      await firstGate;
      mocks.emit({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'hello from pi' }],
          stopReason: 'stop',
        },
      });
    });

    const first = callPi('worker', 'first', sessionOptions('pi-sdk-concurrent'));
    await firstStarted;
    const second = callPi('worker', 'second', sessionOptions('pi-sdk-concurrent'));
    await Promise.resolve();
    expect(mocks.session.prompt).toHaveBeenCalledTimes(1);

    releaseFirst();
    const responses = await Promise.all([first, second]);
    expect(mocks.session.prompt).toHaveBeenCalledTimes(2);
    expect(responses.map((response) => response.status)).toEqual(['done', 'done']);
  });

  it('does not dispose an active session when another configuration replaces it', async () => {
    mocks.resetTransient();
    let markFirstStarted!: () => void;
    let releaseFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    mocks.session.prompt.mockImplementationOnce(async () => {
      markFirstStarted();
      await firstGate;
    });

    const first = callPi('worker', 'first', {
      ...sessionOptions('pi-sdk-config-replacement'),
      systemPrompt: 'first configuration',
    });
    await firstStarted;
    const second = await callPi('worker', 'second', {
      ...sessionOptions('pi-sdk-config-replacement'),
      systemPrompt: 'second configuration',
    });

    expect(second.status).toBe('done');
    expect(mocks.session.dispose).not.toHaveBeenCalled();

    releaseFirst();
    await first;
    expect(mocks.session.dispose).toHaveBeenCalledOnce();
  });

  it('lets an aborted caller stop while it waits for a reused SDK session', async () => {
    mocks.resetTransient();
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    mocks.session.prompt.mockImplementationOnce(async () => {
      markFirstStarted();
      await firstGate;
      mocks.emit({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'hello from pi' }],
          stopReason: 'stop',
        },
      });
    });

    const first = callPi('worker', 'first', sessionOptions('pi-sdk-aborted-waiter'));
    await firstStarted;
    const abortController = new AbortController();
    const second = callPi('worker', 'second', {
      ...sessionOptions('pi-sdk-aborted-waiter'),
      abortSignal: abortController.signal,
    });
    abortController.abort('cancelled while waiting');

    const secondResponse = await second;
    expect(secondResponse.status).toBe('error');
    expect(secondResponse.failureCategory).toBe('external_abort');
    expect(mocks.session.prompt).toHaveBeenCalledTimes(1);

    releaseFirst();
    expect((await first).status).toBe('done');
  });

  it('does not let one caller abort a shared session bootstrap needed by another caller', async () => {
    mocks.resetTransient();
    let markResolutionStarted!: () => void;
    let releaseResolution!: () => void;
    const resolutionStarted = new Promise<void>((resolve) => {
      markResolutionStarted = resolve;
    });
    const resolutionGate = new Promise<void>((resolve) => {
      releaseResolution = resolve;
    });
    mocks.packageManager.resolveExtensionSources.mockImplementationOnce(async () => {
      markResolutionStarted();
      await resolutionGate;
      return {
        extensions: [{ enabled: true, path: path.join(tmpdir(), 'shared-extension.ts') }],
        skills: [],
        prompts: [],
        themes: [],
      };
    });
    const providerOptions = { extensions: ['./shared-extension.ts'] };
    const abortController = new AbortController();
    const first = callPi('worker', 'first', {
      ...sessionOptions('pi-sdk-shared-bootstrap'),
      abortSignal: abortController.signal,
      providerOptions,
    });
    await resolutionStarted;
    const second = callPi('worker', 'second', {
      ...sessionOptions('pi-sdk-shared-bootstrap'),
      providerOptions,
    });
    await Promise.resolve();

    abortController.abort('cancel only the first caller');
    const firstResponse = await first;
    expect(firstResponse.failureCategory).toBe('external_abort');

    releaseResolution();
    const secondResponse = await second;
    expect(secondResponse.status).toBe('done');
    expect(mocks.createAgentSession).toHaveBeenCalledTimes(1);
  });

  it('disposes a late bootstrap result after all original waiters abort', async () => {
    mocks.resetTransient();
    const previousModel = mocks.session.model;
    mocks.session.model = undefined;
    let markModelApplyStarted!: () => void;
    let releaseModelApply!: () => void;
    const modelApplyStarted = new Promise<void>((resolve) => {
      markModelApplyStarted = resolve;
    });
    const modelApplyGate = new Promise<void>((resolve) => {
      releaseModelApply = resolve;
    });
    mocks.session.setModel.mockImplementationOnce(async () => {
      markModelApplyStarted();
      await modelApplyGate;
    });
    const abortController = new AbortController();

    try {
      const first = callPi('worker', 'first', {
        ...sessionOptions('pi-sdk-late-bootstrap'),
        abortSignal: abortController.signal,
      });
      await modelApplyStarted;
      abortController.abort('cancel the only waiter');
      expect((await first).failureCategory).toBe('external_abort');

      const second = await callPi('worker', 'second', sessionOptions('pi-sdk-late-bootstrap'));
      expect(second.status).toBe('done');
      expect(mocks.session.dispose).not.toHaveBeenCalled();

      releaseModelApply();
      await vi.waitFor(() => expect(mocks.session.dispose).toHaveBeenCalledOnce());
      expect(mocks.createAgentSession).toHaveBeenCalledTimes(2);
    } finally {
      releaseModelApply();
      mocks.session.model = previousModel;
    }
  });

  it('stops before loading SDK resources when the signal is already aborted', async () => {
    mocks.resetTransient();
    const abortController = new AbortController();
    abortController.abort('cancelled');

    const response = await callPi('worker', 'stop', {
      ...sessionOptions('pi-sdk-abort'),
      abortSignal: abortController.signal,
    });

    expect(response.status).toBe('error');
    expect(response.failureCategory).toBe('external_abort');
    expect(mocks.createAgentSession).not.toHaveBeenCalled();
    expect(mocks.session.abort).not.toHaveBeenCalled();
  });

  it('stops bootstrap when extension resolution observes an abort', async () => {
    mocks.resetTransient();
    const abortController = new AbortController();
    mocks.packageManager.resolveExtensionSources.mockImplementationOnce(async () => {
      abortController.abort('cancelled during extension resolution');
      return { extensions: [], skills: [], prompts: [], themes: [] };
    });

    const response = await callPi('worker', 'stop', {
      ...sessionOptions('pi-sdk-bootstrap-abort'),
      abortSignal: abortController.signal,
      providerOptions: { extensions: ['npm:example-extension'] },
    });

    expect(response.status).toBe('error');
    expect(response.failureCategory).toBe('external_abort');
    expect(mocks.resourceLoader).not.toHaveBeenCalled();
    expect(mocks.createAgentSession).not.toHaveBeenCalled();
  });

  it('classifies an SDK-reported aborted turn as an external abort', async () => {
    mocks.resetTransient();
    mocks.session.prompt.mockImplementationOnce(async () => {
      mocks.emit({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [],
          stopReason: 'aborted',
        },
      });
    });

    const response = await callPi('worker', 'stop', sessionOptions('pi-sdk-reported-abort'));

    expect(response.status).toBe('error');
    expect(response.failureCategory).toBe('external_abort');
  });
});
