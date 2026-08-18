import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  let listener: ((event: unknown) => void) | undefined;
  let promptOptions: unknown;
  let loaderOptions: unknown;
  let extensionLoadErrors: Array<{ path: string; error: string }> = [];
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
    resolveExtensionSources: vi.fn(async () => ({ extensions: [], skills: [], prompts: [], themes: [] })),
  };
  const sessionManager = {
    inMemory: vi.fn(() => ({ newSession: vi.fn() })),
  };
  const extensionResult = () => ({
    extensions: [],
    errors: extensionLoadErrors,
    runtime: {
      pendingProviderRegistrations,
      pendingNativeProviderRegistrations: [],
    },
  });

  return {
    session,
    modelRuntime,
    packageManager,
    createAgentSession: vi.fn(async () => {
      session.sessionId = `sdk-session-${++sessionSequence}`;
      return { session, extensionsResult: extensionResult() };
    }),
    modelRuntimeCreate: vi.fn(async () => modelRuntime),
    resourceLoader: vi.fn((options: unknown) => {
      loaderOptions = options;
      return {
        reload: vi.fn(async () => undefined),
        getExtensions: vi.fn(() => extensionResult()),
      };
    }),
    createBashToolDefinition: vi.fn(() => ({ name: 'bash' })),
    packageManagerConstructor: vi.fn(() => packageManager),
    settingsManagerInMemory: vi.fn(() => ({})),
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
      mocks.packageManager.resolveExtensionSources.mockClear();
      mocks.modelRuntime.getModel.mockClear();
      mocks.modelRuntime.getModels.mockClear();
      mocks.modelRuntime.registerProvider.mockClear();
      mocks.modelRuntime.registerNativeProvider.mockClear();
    },
    setExtensionLoadErrors: (errors: Array<{ path: string; error: string }>) => {
      extensionLoadErrors = errors;
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

  it('falls back to temporary npm extension sources when user and project scopes are empty', async () => {
    mocks.resetTransient();
    const empty = { extensions: [], skills: [], prompts: [], themes: [] };
    const temporary = {
      extensions: [{ enabled: true, path: path.join(tmpdir(), 'extension.ts') }],
      skills: [{ enabled: true, path: path.join(tmpdir(), 'SKILL.md') }],
      prompts: [],
      themes: [],
    };
    mocks.packageManager.resolveExtensionSources
      .mockResolvedValueOnce(empty)
      .mockResolvedValueOnce(empty)
      .mockResolvedValueOnce(temporary);

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

    expect(mocks.packageManager.resolveExtensionSources).toHaveBeenNthCalledWith(
      1,
      ['npm:example-extension'],
      { local: true },
    );
    expect(mocks.packageManager.resolveExtensionSources).toHaveBeenNthCalledWith(
      2,
      ['npm:example-extension'],
    );
    expect(mocks.packageManager.resolveExtensionSources).toHaveBeenNthCalledWith(
      3,
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

  it('falls back to temporary npm extension sources when project and user scopes reject', async () => {
    mocks.resetTransient();
    const temporary = {
      extensions: [{ enabled: true, path: path.join(tmpdir(), 'temporary-extension.ts') }],
      skills: [],
      prompts: [],
      themes: [],
    };
    mocks.packageManager.resolveExtensionSources
      .mockRejectedValueOnce(new Error('project scope failed'))
      .mockRejectedValueOnce(new Error('user scope failed'))
      .mockResolvedValueOnce(temporary);

    const response = await callPi('worker', 'use the extension', {
      ...sessionOptions('pi-sdk-reject-fallback'),
      providerOptions: {
        extensions: ['npm:example-extension'],
      },
    });

    expect(response.status).toBe('done');
    expect(mocks.packageManager.resolveExtensionSources).toHaveBeenNthCalledWith(
      1,
      ['npm:example-extension'],
      { local: true },
    );
    expect(mocks.packageManager.resolveExtensionSources).toHaveBeenNthCalledWith(
      2,
      ['npm:example-extension'],
    );
    expect(mocks.packageManager.resolveExtensionSources).toHaveBeenNthCalledWith(
      3,
      ['npm:example-extension'],
      { temporary: true },
    );
    expect(mocks.getLoaderOptions()).toMatchObject({
      additionalExtensionPaths: [path.join(tmpdir(), 'temporary-extension.ts')],
    });
  });

  it('stops extension resolution after project scope rejects when abort is requested', async () => {
    mocks.resetTransient();
    const abortController = new AbortController();
    mocks.packageManager.resolveExtensionSources.mockImplementationOnce(async () => {
      abortController.abort('cancelled during project scope rejection');
      throw new Error('project scope failed');
    });

    const response = await callPi('worker', 'use the extension', {
      ...sessionOptions('pi-sdk-project-reject-abort'),
      abortSignal: abortController.signal,
      providerOptions: {
        extensions: ['npm:example-extension'],
      },
    });

    expect(response.status).toBe('error');
    expect(response.failureCategory).toBe('external_abort');
    expect(mocks.packageManager.resolveExtensionSources).toHaveBeenCalledTimes(1);
    expect(mocks.packageManager.resolveExtensionSources).toHaveBeenNthCalledWith(
      1,
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
    expect(mocks.resourceLoader).not.toHaveBeenCalled();
    expect(mocks.createAgentSession).not.toHaveBeenCalled();
  });

  it('uses user-scope npm extension when project scope rejects', async () => {
    mocks.resetTransient();
    const userScope = {
      extensions: [{ enabled: true, path: path.join(tmpdir(), 'user-extension.ts') }],
      skills: [],
      prompts: [],
      themes: [],
    };
    mocks.packageManager.resolveExtensionSources
      .mockRejectedValueOnce(new Error('project scope failed'))
      .mockResolvedValueOnce(userScope);

    const response = await callPi('worker', 'use the extension', {
      ...sessionOptions('pi-sdk-project-reject-user-scope'),
      providerOptions: {
        extensions: ['npm:pi-cursor-sdk'],
      },
    });

    expect(response.status).toBe('done');
    expect(mocks.packageManager.resolveExtensionSources).toHaveBeenCalledTimes(2);
    expect(mocks.packageManager.resolveExtensionSources).toHaveBeenNthCalledWith(
      1,
      ['npm:pi-cursor-sdk'],
      { local: true },
    );
    expect(mocks.packageManager.resolveExtensionSources).toHaveBeenNthCalledWith(
      2,
      ['npm:pi-cursor-sdk'],
    );
    expect(mocks.packageManager.resolveExtensionSources).not.toHaveBeenCalledWith(
      ['npm:pi-cursor-sdk'],
      { temporary: true },
    );
    expect(mocks.getLoaderOptions()).toMatchObject({
      additionalExtensionPaths: [path.join(tmpdir(), 'user-extension.ts')],
    });
  });

  it('prefers a loadable user-scope npm extension over temporary install', async () => {
    mocks.resetTransient();
    const empty = { extensions: [], skills: [], prompts: [], themes: [] };
    const userScope = {
      extensions: [{ enabled: true, path: path.join(tmpdir(), 'user-extension.ts') }],
      skills: [],
      prompts: [],
      themes: [],
    };
    mocks.packageManager.resolveExtensionSources
      .mockResolvedValueOnce(empty)
      .mockResolvedValueOnce(userScope);

    const response = await callPi('worker', 'use the extension', {
      ...sessionOptions('pi-sdk-user-scope-extension'),
      providerOptions: {
        extensions: ['npm:pi-cursor-sdk'],
      },
    });

    expect(response.status).toBe('done');
    expect(mocks.packageManager.resolveExtensionSources).toHaveBeenCalledTimes(2);
    expect(mocks.packageManager.resolveExtensionSources).toHaveBeenNthCalledWith(
      1,
      ['npm:pi-cursor-sdk'],
      { local: true },
    );
    expect(mocks.packageManager.resolveExtensionSources).toHaveBeenNthCalledWith(
      2,
      ['npm:pi-cursor-sdk'],
    );
    expect(mocks.packageManager.resolveExtensionSources).not.toHaveBeenCalledWith(
      ['npm:pi-cursor-sdk'],
      { temporary: true },
    );
    expect(mocks.getLoaderOptions()).toMatchObject({
      additionalExtensionPaths: [path.join(tmpdir(), 'user-extension.ts')],
    });
  });

  it('prefers a loadable project-scope npm extension before user and temporary scopes', async () => {
    mocks.resetTransient();
    const projectScope = {
      extensions: [{ enabled: true, path: path.join(tmpdir(), 'project-extension.ts') }],
      skills: [],
      prompts: [],
      themes: [],
    };
    mocks.packageManager.resolveExtensionSources.mockResolvedValueOnce(projectScope);

    const response = await callPi('worker', 'use the extension', {
      ...sessionOptions('pi-sdk-project-scope-extension'),
      providerOptions: {
        extensions: ['npm:pi-cursor-sdk'],
      },
    });

    expect(response.status).toBe('done');
    expect(mocks.packageManager.resolveExtensionSources).toHaveBeenCalledOnce();
    expect(mocks.packageManager.resolveExtensionSources).toHaveBeenCalledWith(
      ['npm:pi-cursor-sdk'],
      { local: true },
    );
    expect(mocks.getLoaderOptions()).toMatchObject({
      additionalExtensionPaths: [path.join(tmpdir(), 'project-extension.ts')],
    });
  });

  it('falls through when a higher npm scope resolves only disabled resources', async () => {
    mocks.resetTransient();
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
    mocks.packageManager.resolveExtensionSources
      .mockResolvedValueOnce(disabledOnly)
      .mockResolvedValueOnce(disabledOnly)
      .mockResolvedValueOnce(temporary);

    const response = await callPi('worker', 'use the extension', {
      ...sessionOptions('pi-sdk-disabled-only-fallback'),
      providerOptions: {
        extensions: ['npm:example-extension'],
      },
    });

    expect(response.status).toBe('done');
    expect(mocks.packageManager.resolveExtensionSources).toHaveBeenNthCalledWith(
      1,
      ['npm:example-extension'],
      { local: true },
    );
    expect(mocks.packageManager.resolveExtensionSources).toHaveBeenNthCalledWith(
      2,
      ['npm:example-extension'],
    );
    expect(mocks.packageManager.resolveExtensionSources).toHaveBeenNthCalledWith(
      3,
      ['npm:example-extension'],
      { temporary: true },
    );
    expect(mocks.getLoaderOptions()).toMatchObject({
      additionalExtensionPaths: [path.join(tmpdir(), 'temporary-extension.ts')],
    });
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
