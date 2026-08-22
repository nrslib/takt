#!/usr/bin/env node

import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import {
  createAgentSession,
  DefaultPackageManager,
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
const projectPackageRoot = join(cwd, '.pi', 'npm', 'node_modules', 'project-probe');
const projectExtensionPath = join(projectPackageRoot, 'index.js');
const brokenProjectPackageRoot = join(cwd, '.pi', 'npm', 'node_modules', 'broken-probe');
const fallbackUserPackageRoot = join(agentDir, 'npm', 'node_modules', 'broken-probe');
const fallbackUserExtensionPath = join(fallbackUserPackageRoot, 'index.js');
const implicitExtensionPath = join(cwd, '.pi', 'extensions', 'implicit-probe.js');

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

  await mkdir(projectPackageRoot, { recursive: true });
  await writeFile(join(projectPackageRoot, 'package.json'), JSON.stringify({
    name: 'project-probe',
    version: '1.0.0',
    type: 'module',
    pi: { extensions: ['./index.js'] },
  }, null, 2), 'utf8');
  await writeFile(projectExtensionPath, `
export default function projectProbe(pi) {
  pi.on('session_start', () => {
    pi.registerTool({
      name: 'project_probe',
      label: 'Project probe',
      description: 'Explicit project package probe',
      parameters: { type: 'object', properties: {} },
      async execute() {
        return { content: [{ type: 'text', text: 'ok' }], details: {} };
      },
    });
  });
}
`, 'utf8');
  await mkdir(brokenProjectPackageRoot, { recursive: true });
  await writeFile(join(brokenProjectPackageRoot, 'package.json'), JSON.stringify({
    name: 'broken-probe',
    version: '1.0.0',
  }, null, 2), 'utf8');
  await mkdir(fallbackUserPackageRoot, { recursive: true });
  await writeFile(join(fallbackUserPackageRoot, 'package.json'), JSON.stringify({
    name: 'broken-probe',
    version: '1.0.0',
    type: 'module',
    pi: { extensions: ['./index.js'] },
  }, null, 2), 'utf8');
  await writeFile(fallbackUserExtensionPath, `
export default function userProbe(pi) {
  pi.on('session_start', () => {});
}
`, 'utf8');
  await mkdir(join(cwd, '.pi', 'extensions'), { recursive: true });
  await writeFile(implicitExtensionPath, `
export default function implicitProbe(pi) {
  pi.on('session_start', () => {
    pi.registerTool({
      name: 'implicit_project_probe',
      label: 'Implicit project probe',
      description: 'Must stay disabled',
      parameters: { type: 'object', properties: {} },
      async execute() {
        return { content: [{ type: 'text', text: 'unexpected' }], details: {} };
      },
    });
  });
}
`, 'utf8');

  const settingsManager = SettingsManager.inMemory({}, { projectTrusted: false });
  const projectLookupSettings = SettingsManager.inMemory({}, { projectTrusted: true });
  const projectLookupManager = new DefaultPackageManager({
    cwd,
    agentDir,
    settingsManager: projectLookupSettings,
  });
  const projectInstallPath = projectLookupManager.getInstalledPath('npm:project-probe', 'project');
  assert.equal(projectInstallPath, projectPackageRoot);

  const operationalPackageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
  const brokenProjectInstallPath = projectLookupManager.getInstalledPath('npm:broken-probe', 'project');
  assert.equal(brokenProjectInstallPath, brokenProjectPackageRoot);
  const brokenProjectResources = await operationalPackageManager.resolveExtensionSources(
    [brokenProjectInstallPath],
    { temporary: true },
  );
  assert.deepEqual(
    brokenProjectResources.extensions.filter((resource) => resource.enabled).map((resource) => resource.path),
    [brokenProjectPackageRoot],
  );
  const brokenProjectLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    additionalExtensionPaths: brokenProjectResources.extensions
      .filter((resource) => resource.enabled)
      .map((resource) => resource.path),
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await brokenProjectLoader.reload();
  assert.ok(brokenProjectLoader.getExtensions().errors.length > 0);

  const fallbackUserInstallPath = operationalPackageManager.getInstalledPath('npm:broken-probe', 'user');
  assert.equal(fallbackUserInstallPath, fallbackUserPackageRoot);
  const fallbackUserResources = await operationalPackageManager.resolveExtensionSources(
    [fallbackUserInstallPath],
    { temporary: true },
  );
  const fallbackUserLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    additionalExtensionPaths: fallbackUserResources.extensions
      .filter((resource) => resource.enabled)
      .map((resource) => resource.path),
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await fallbackUserLoader.reload();
  assert.deepEqual(fallbackUserLoader.getExtensions().errors, []);

  const projectResources = await operationalPackageManager.resolveExtensionSources(
    [projectInstallPath],
    { temporary: true },
  );
  assert.deepEqual(
    projectResources.extensions.filter((resource) => resource.enabled).map((resource) => resource.path),
    [projectExtensionPath],
  );
  assert.equal(await pathExists(join(agentDir, 'tmp', 'extensions', 'npm')), false);

  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    additionalExtensionPaths: [
      extensionPath,
      ...projectResources.extensions.filter((resource) => resource.enabled).map((resource) => resource.path),
    ],
    noExtensions: false,
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
  assert.equal(session.getAllTools().some((tool) => tool.name === 'project_probe'), true);
  assert.equal(session.getAllTools().some((tool) => tool.name === 'implicit_project_probe'), false);
  session.setActiveToolsByName(['platform_probe']);
  assert.deepEqual(session.getActiveToolNames(), ['platform_probe']);
  session.dispose();

  for (const file of ['auth.json', 'models.json', 'models-store.json', 'settings.json']) {
    assert.equal(await pathExists(join(agentDir, file)), false, `${file} must stay in memory`);
  }
  assert.equal(await pathExists(join(cwd, '.pi', 'settings.json')), false);
  console.log(`pi-sdk-cross-platform-smoke: ok (${process.platform}/${process.arch})`);
} finally {
  await rm(root, { recursive: true, force: true });
}
