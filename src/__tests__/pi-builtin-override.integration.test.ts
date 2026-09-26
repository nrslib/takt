import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolInfo,
} from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore, InMemoryModelsStore } from '@earendil-works/pi-ai';
import { resolvePiActiveTools } from '../infra/providers/pi-tool-policy.js';
import { callPi } from '../infra/pi/client.js';
import type { PiCallOptions } from '../infra/pi/types.js';
import type { StreamEvent } from '../shared/types/provider.js';
import { CLIENT_READ_DESCRIPTION, CLIENT_READ_MARKER } from './fixtures/pi-client-read-override.js';

const READ_OVERRIDE_SENTINEL = 'takt-builtin-override-sentinel';
const READ_OVERRIDE_DESCRIPTION = 'TAKT fixture read override';

function readOverrideExtensionSource(projectCwd: string): string {
  return `
import { createReadToolDefinition } from '@earendil-works/pi-coding-agent';

export default function registerOverrideReadTool(pi) {
  pi.on('session_start', () => {
    pi.registerTool({
      ...createReadToolDefinition(${JSON.stringify(projectCwd)}),
      label: 'TAKT fixture read override',
      description: ${JSON.stringify(READ_OVERRIDE_DESCRIPTION)},
    });
  });
}
`;
}

interface OverrideSession {
  readonly root: string;
  readonly cwd: string;
  readonly extensionPath: string;
  readonly session: AgentSession;
}

async function createOverrideReadSession(): Promise<OverrideSession> {
  const root = mkdtempSync(path.join(tmpdir(), 'takt-pi-builtin-override-'));
  let session: AgentSession | undefined;
  try {
    const cwd = path.join(root, 'project');
    const agentDir = path.join(root, 'agent');
    const extensionPath = path.join(root, 'override-read-extension.js');
    const ignoredOrderPath = path.join(cwd, '.takt/runs/x/context/task/order.md');
    mkdirSync(path.dirname(ignoredOrderPath), { recursive: true });
    writeFileSync(path.join(cwd, '.gitignore'), '.takt/\n', 'utf8');
    writeFileSync(ignoredOrderPath, `# order\n${READ_OVERRIDE_SENTINEL}\n`, 'utf8');
    writeFileSync(extensionPath, readOverrideExtensionSource(cwd), 'utf8');

    const settingsManager = SettingsManager.inMemory({}, { projectTrusted: false });
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      additionalExtensionPaths: [extensionPath],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await resourceLoader.reload();
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      modelsStore: new InMemoryModelsStore(),
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    const result = await createAgentSession({
      cwd,
      agentDir,
      modelRuntime,
      resourceLoader,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager,
    });
    session = result.session;
    const bindErrors: unknown[] = [];
    await session.bindExtensions({
      mode: 'print',
      onError: (error) => bindErrors.push(error),
    });
    expect(result.extensionsResult.errors).toEqual([]);
    expect(bindErrors).toEqual([]);
    return { root, cwd, extensionPath, session };
  } catch (error) {
    session?.dispose();
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function disposeOverrideSession(setup: OverrideSession): void {
  setup.session.dispose();
  rmSync(setup.root, { recursive: true, force: true });
}

function toolInfos(setup: OverrideSession, allTools: ToolInfo[]) {
  return allTools.map((tool) => ({
    name: tool.name,
    source: tool.sourceInfo.source,
    sourcePath: path.resolve(setup.cwd, tool.sourceInfo.path),
  }));
}

describe('Pi builtin override integration', () => {
  it('activates an explicitly trusted extension read as the single read implementation', async () => {
    const setup = await createOverrideReadSession();
    try {
      const allTools = setup.session.getAllTools();
      const readEntries = allTools.filter((tool) => tool.name === 'read');
      expect(readEntries).toHaveLength(1);
      expect(readEntries[0]!.description).toBe(READ_OVERRIDE_DESCRIPTION);
      expect(path.resolve(setup.cwd, readEntries[0]!.sourceInfo.path)).toBe(setup.extensionPath);

      const activeTools = resolvePiActiveTools(
        'readonly',
        undefined,
        toolInfos(setup, allTools),
        [path.resolve(setup.cwd, setup.extensionPath)],
      );
      expect(activeTools).toEqual(['read', 'grep', 'find', 'ls']);

      setup.session.setActiveToolsByName(activeTools);
      expect(setup.session.getActiveToolNames()).toEqual(['read', 'grep', 'find', 'ls']);

      const readTool = setup.session.state.tools.find((tool) => tool.name === 'read');
      expect(readTool).toBeDefined();
      const result = await readTool!.execute(
        'takt-override-read',
        { path: '.takt/runs/x/context/task/order.md' },
        undefined,
        undefined,
      );
      const contentText = result.content
        .map((content) => (content.type === 'text' ? content.text : ''))
        .join('\n');
      expect(contentText).toContain(READ_OVERRIDE_SENTINEL);
    } finally {
      disposeOverrideSession(setup);
    }
  });

  it('keeps the same extension read inactive when it is not explicitly trusted', async () => {
    const setup = await createOverrideReadSession();
    try {
      const allTools = setup.session.getAllTools();
      expect(allTools.filter((tool) => tool.name === 'read')).toHaveLength(1);

      const activeTools = resolvePiActiveTools('readonly', undefined, toolInfos(setup, allTools), []);
      expect(activeTools).toEqual(['grep', 'find', 'ls']);

      setup.session.setActiveToolsByName(activeTools);
      expect(setup.session.getActiveToolNames()).toEqual(['grep', 'find', 'ls']);
    } finally {
      disposeOverrideSession(setup);
    }
  });
});

describe('Pi builtin override through the TAKT client', () => {
  it('still fails closed when session_start replaces the snapshotted builtin owner', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'takt-pi-client-late-override-'));
    const extensionPath = path.join(root, 'late-read-extension.js');
    const activeTools = vi.spyOn(AgentSession.prototype, 'setActiveToolsByName');
    const abort = vi.spyOn(AgentSession.prototype, 'abort');
    const prompt = vi.spyOn(AgentSession.prototype, 'prompt');
    const dispose = vi.spyOn(AgentSession.prototype, 'dispose');
    try {
      writeFileSync(extensionPath, readOverrideExtensionSource(root), 'utf8');
      vi.stubEnv('PI_CODING_AGENT_DIR', path.join(root, 'agent'));
      const response = await callPi('worker', 'Must not run after provenance changes.', {
        cwd: root,
        permissionMode: 'readonly',
        providerOptions: {
          extensions: [extensionPath],
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
        },
      });
      expect(response.error).toContain('Pi explicit extension provenance could not be verified');
      expect(response.status).not.toBe('done');
      expect(activeTools).toHaveBeenCalledWith([]);
      expect(abort).toHaveBeenCalled();
      expect(prompt).not.toHaveBeenCalled();
      expect(dispose).toHaveBeenCalledOnce();
    } finally {
      activeTools.mockRestore();
      abort.mockRestore();
      prompt.mockRestore();
      dispose.mockRestore();
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  const cases: Array<{
    label: string;
    mode: PiCallOptions['permissionMode'];
    allowedTools?: string[];
    expected: string[];
  }> = [
    { label: 'readonly', mode: 'readonly', expected: ['read', 'grep', 'find', 'ls'] },
    { label: 'edit allowlist', mode: 'edit', allowedTools: ['Read'], expected: ['read'] },
    { label: 'unset-mode allowlist', mode: undefined, allowedTools: ['read'], expected: ['read'] },
    { label: 'full readonly allowlist', mode: 'full', allowedTools: ['read'], expected: ['read'] },
    { label: 'excluded read', mode: 'readonly', allowedTools: ['grep'], expected: ['grep'] },
    { label: 'deny-all', mode: 'readonly', allowedTools: [], expected: [] },
  ];

  it.each(cases)('enforces $label through bind, refresh and a real SDK turn', async ({ mode, allowedTools, expected }) => {
    const root = mkdtempSync(path.join(tmpdir(), 'takt-pi-client-override-'));
    const cwd = path.join(root, 'project');
    const extensionPath = fileURLToPath(new URL('./fixtures/pi-client-read-override.ts', import.meta.url));
    const orderPath = path.join(cwd, '.takt/runs/x/context/task/order.md');
    let session: AgentSession | undefined;
    let beforeBind: ToolInfo[] = [];
    const originalBind = AgentSession.prototype.bindExtensions;
    const bind = vi.spyOn(AgentSession.prototype, 'bindExtensions').mockImplementation(async function (this: AgentSession, options) {
      session = this;
      beforeBind = this.getAllTools();
      return originalBind.call(this, options);
    });
    const events: StreamEvent[] = [];
    try {
      mkdirSync(path.dirname(orderPath), { recursive: true });
      writeFileSync(path.join(cwd, '.gitignore'), '.takt/\n', 'utf8');
      writeFileSync(orderPath, `${READ_OVERRIDE_SENTINEL}\n`, 'utf8');
      vi.stubEnv('PI_CODING_AGENT_DIR', path.join(root, 'agent'));

      const response = await callPi('worker', 'Read the order if read is active.', {
        cwd,
        model: 'takt-override-test/read-fixture',
        permissionMode: mode,
        allowedTools,
        providerOptions: {
          extensions: [extensionPath],
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
        },
        onStream: (event) => events.push(event),
      });

      expect(response.error).toBeUndefined();
      expect(response.status).toBe('done');
      expect(bind).toHaveBeenCalledOnce();
      // The client snapshots the extension, not the replaced builtin, before bind.
      for (const registry of [beforeBind, session!.getAllTools()]) {
        const reads = registry.filter((tool) => tool.name === 'read');
        expect(reads).toHaveLength(1);
        expect(reads[0]!.description).toBe(CLIENT_READ_DESCRIPTION);
        expect(path.resolve(cwd, reads[0]!.sourceInfo.path)).toBe(extensionPath);
        expect(reads[0]!.sourceInfo.source).not.toBe('builtin');
      }
      expect(session!.getActiveToolNames()).toEqual(expected);
      const toolCalls = events.filter((event) => event.type === 'tool_use');
      if (expected.includes('read')) {
        expect(toolCalls.map((event) => event.data.tool)).toEqual(['read']);
        expect(events).toContainEqual({
          type: 'tool_result',
          data: expect.objectContaining({
            isError: false,
            content: expect.stringContaining(READ_OVERRIDE_SENTINEL),
          }),
        });
        expect(response.content).toContain(READ_OVERRIDE_SENTINEL);
        expect(response.content).toContain(CLIENT_READ_MARKER);
      } else {
        expect(toolCalls).toEqual([]);
        expect(response.content).toBe('read unavailable');
      }
    } finally {
      session?.dispose();
      bind.mockRestore();
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
