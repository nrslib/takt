#!/usr/bin/env node

import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
} from '@earendil-works/pi-ai';

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const root = await mkdtemp(join(tmpdir(), 'takt-pi-sdk-'));
const cwd = join(root, 'project');
const agentDir = join(root, 'agent');
const extensionPath = join(root, 'platform-probe.js');

try {
  await mkdir(cwd, { recursive: true });
  await writeFile(extensionPath, `
import { Type } from 'typebox';

export default function platformProbe(pi) {
  pi.on('session_start', () => {
    pi.registerTool({
      name: 'platform_probe',
      label: 'Platform probe',
      description: 'Cross-platform SDK registration probe',
      parameters: Type.Object({}),
      async execute() {
        return { content: [{ type: 'text', text: 'ok' }], details: {} };
      },
    });
  });
}
`, 'utf8');

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
  assert.deepEqual(resourceLoader.getExtensions().errors, []);

  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    modelsStore: new InMemoryModelsStore(),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const sessionManager = SessionManager.inMemory(cwd);
  assert.equal(sessionManager.isPersisted(), false);
  const { session, extensionsResult } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    resourceLoader,
    sessionManager,
    settingsManager,
  });
  assert.deepEqual(extensionsResult.errors, []);

  const runtimeErrors = [];
  await session.bindExtensions({
    mode: 'print',
    onError: (error) => runtimeErrors.push(error),
  });
  assert.deepEqual(runtimeErrors, []);
  assert.equal(session.getAllTools().some((tool) => tool.name === 'platform_probe'), true);
  session.setActiveToolsByName(['platform_probe']);
  assert.deepEqual(session.getActiveToolNames(), ['platform_probe']);
  session.dispose();

  for (const file of ['auth.json', 'models.json', 'models-store.json', 'settings.json']) {
    assert.equal(await pathExists(join(agentDir, file)), false, `${file} must stay in memory`);
  }
  console.log(`pi-sdk-cross-platform-smoke: ok (${process.platform}/${process.arch})`);
} finally {
  await rm(root, { recursive: true, force: true });
}
