import { dirname } from 'node:path';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import type { WorkflowConfig } from '../../../core/models/index.js';
import { getRepertoireDir } from '../paths.js';
import { resolveWorkflowConfigValue } from '../resolveWorkflowConfigValue.js';
import { loadGlobalConfig } from '../global/globalConfig.js';
import { loadProjectConfig } from '../project/projectConfig.js';
import type { FacetResolutionContext } from './resource-resolver.js';
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
} from './workflowSourceMetadata.js';
import type { WorkflowCallArgResolutionPolicy } from './workflowCallableArgResolver.js';
import { resolveWorkflowTrustInfo, type WorkflowTrustInfo } from './workflowTrustSource.js';

interface LoadWorkflowFromFileOptions {
  trustInfo?: WorkflowTrustInfo;
  callableArgs?: Record<string, string | string[]>;
  callableArgPolicy?: WorkflowCallArgResolutionPolicy;
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
  const raw = parseYaml(readFileSync(canonicalFilePath, 'utf-8'));
  const workflowDir = dirname(canonicalFilePath);
  const context: FacetResolutionContext = {
    lang: resolveWorkflowConfigValue(projectDir, 'language'),
    projectDir,
    workflowDir,
    repertoireDir: getRepertoireDir(),
  };

  const projectConfig = loadProjectConfig(projectDir);
  const globalConfig = loadGlobalConfig();
  const trustInfo = options?.trustInfo ?? resolveWorkflowTrustInfo({
    filePath: canonicalFilePath,
    projectCwd: projectDir,
  });

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
  attachWorkflowOpaqueRef(config, buildOpaqueWorkflowRef(canonicalFilePath, trustInfo));
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
