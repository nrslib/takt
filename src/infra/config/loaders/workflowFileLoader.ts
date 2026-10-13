import { dirname, relative, sep } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { readWorkflowFile } from './workflow-file-reader.js';
import { parse as parseYaml } from 'yaml';
import type { WorkflowCallArgValue, WorkflowConfig } from '../../../core/models/index.js';
import { isNormalOrTeamLeaderWorkflowStep } from '../../../core/models/types.js';
import { getRepertoireDir, isPathSafe } from '../paths.js';
import { getResourcesDir } from '../../resources/index.js';
import { resolveWorkflowConfigValue } from '../resolveWorkflowConfigValue.js';
import { loadGlobalConfig } from '../global/globalConfig.js';
import { loadProjectConfig } from '../project/projectConfig.js';
import type { FacetResolutionContext } from './resource-resolver.js';
import { isPackageWorkflow } from './workflowPackageScope.js';
import { normalizeWorkflowConfig } from './workflowParser.js';
import {
  resolveWorkflowArpeggioPolicy,
  resolveWorkflowCommandGatesPolicy,
  resolveWorkflowMcpServersPolicy,
  resolveWorkflowRuntimePreparePolicy,
} from './workflowNormalizationPolicies.js';
import {
  attachWorkflowSourcePath,
  attachWorkflowTrustInfo,
  attachWorkflowOpaqueRef,
  buildOpaqueWorkflowRef,
  buildBuiltinWorkflowRef,
} from './workflowSourceMetadata.js';
import type { WorkflowCallArgResolutionPolicy } from './workflowCallableArgResolver.js';
import { resolveWorkflowTrustInfo, type WorkflowTrustInfo } from './workflowTrustSource.js';
import { buildConfiguredCompanionLookupDirs } from './companionLookupDirectories.js';
import { loadCompanionDefinition } from './companionDefinitionLoader.js';

interface LoadWorkflowFromFileOptions {
  trustInfo?: WorkflowTrustInfo;
  callableArgs?: Record<string, WorkflowCallArgValue>;
  callableArgPolicy?: WorkflowCallArgResolutionPolicy;
  resourceRoot?: string;
}

type WorkflowLoadMode = 'runtime' | 'discovery';

function loadWorkflowFromFileInternal(
  filePath: string,
  projectDir: string,
  options: LoadWorkflowFromFileOptions | undefined,
  loadMode: WorkflowLoadMode,
): WorkflowConfig {
  if (!existsSync(filePath)) {
    throw new Error(`Workflow file not found: ${filePath}`);
  }

  const canonicalFilePath = realpathSync(filePath);
  const content = readWorkflowFile(canonicalFilePath);
  const raw = parseYaml(content);
  const projectConfig = loadProjectConfig(projectDir);
  const globalConfig = loadGlobalConfig();
  const trustInfo = options?.trustInfo ?? resolveWorkflowTrustInfo({
    filePath: canonicalFilePath,
    projectCwd: projectDir,
  });
  const configuredRepertoireDir = getRepertoireDir();
  const logicalWorkflowDir = dirname(filePath);
  const useLogicalRepertoireBoundary = trustInfo.source === 'repertoire'
    && isPackageWorkflow(logicalWorkflowDir, configuredRepertoireDir);
  const repertoireDir = trustInfo.source === 'repertoire'
    && !useLogicalRepertoireBoundary
    && existsSync(configuredRepertoireDir)
    ? realpathSync(configuredRepertoireDir)
    : configuredRepertoireDir;
  const workflowDir = useLogicalRepertoireBoundary
    ? logicalWorkflowDir
    : dirname(canonicalFilePath);
  const context: FacetResolutionContext = {
    lang: resolveWorkflowConfigValue(projectDir, 'language'),
    projectDir,
    workflowDir,
    repertoireDir,
    resourceRoot: options?.resourceRoot,
  };

  const config = normalizeWorkflowConfig(
    raw,
    workflowDir,
    context,
    projectConfig.workflowOverrides,
    globalConfig.workflowOverrides,
    resolveWorkflowRuntimePreparePolicy(
      globalConfig.workflowRuntimePrepare,
      projectConfig.workflowRuntimePrepare,
    ),
    resolveWorkflowArpeggioPolicy(
      globalConfig.workflowArpeggio,
      projectConfig.workflowArpeggio,
    ),
    resolveWorkflowMcpServersPolicy(
      globalConfig.workflowMcpServers,
      projectConfig.workflowMcpServers,
    ),
    {
      callableArgs: options?.callableArgs,
      callableArgPolicy: options?.callableArgPolicy,
      callableArgMode: loadMode,
      workflowCommandGatesPolicy: resolveWorkflowCommandGatesPolicy(
        globalConfig.workflowCommandGates,
        projectConfig.workflowCommandGates,
      ),
      workflowPath: canonicalFilePath,
      workflowTrustInfo: trustInfo,
    },
  );
  const companionNames = new Set<string>();
  for (const step of config.steps) {
    if (!isNormalOrTeamLeaderWorkflowStep(step) || step.companion === undefined) continue;
    for (const name of step.companion.fixed) companionNames.add(name);
    for (const name of step.companion.pool) companionNames.add(name);
    if (step.companion.moderator !== undefined) companionNames.add(step.companion.moderator);
  }
  if (companionNames.size > 0) {
    const candidateDirs = buildConfiguredCompanionLookupDirs(
      projectDir,
      context.lang,
      context.resourceRoot,
    );
    config.companions = Object.fromEntries([...companionNames].map((name) => [
      name,
      loadCompanionDefinition(name, {
        candidateDirs,
        language: context.lang,
        facetContext: context,
      }),
    ]));
  }
  let workflowRef: string;
  if (trustInfo.source === 'builtin') {
    const builtinRoot = realpathSync(getResourcesDir());
    if (!isPathSafe(builtinRoot, canonicalFilePath)) {
      throw new Error(`Builtin workflow file is outside the builtin resources directory: ${canonicalFilePath}`);
    }
    const relativePath = relative(builtinRoot, canonicalFilePath).split(sep).join('/');
    workflowRef = buildBuiltinWorkflowRef(relativePath, content);
  } else {
    workflowRef = buildOpaqueWorkflowRef(canonicalFilePath, trustInfo);
  }
  attachWorkflowOpaqueRef(config, workflowRef);
  attachWorkflowSourcePath(config, canonicalFilePath);
  attachWorkflowTrustInfo(config, trustInfo);
  return config;
}

export function loadWorkflowFromFile(
  filePath: string,
  projectDir: string,
  options?: LoadWorkflowFromFileOptions,
): WorkflowConfig {
  return loadWorkflowFromFileInternal(filePath, projectDir, options, 'runtime');
}

export function loadWorkflowFromFileForDiscovery(
  filePath: string,
  projectDir: string,
  options?: LoadWorkflowFromFileOptions,
): WorkflowConfig {
  return loadWorkflowFromFileInternal(filePath, projectDir, options, 'discovery');
}
