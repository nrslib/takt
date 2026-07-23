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
  buildOpaqueWorkflowRef,
} from './workflowSourceMetadata.js';
import { isBuiltinWorkflowPath } from '../paths.js';
import {
  issueReviewerAnomalyDefinitionCapability as storeReviewerAnomalyDefinitionCapability,
  issueWorkflowOpaqueRef,
} from '../../../core/workflow/reviewer-anomaly-capability-storage.js';
import type { WorkflowCallArgResolutionPolicy } from './workflowCallableArgResolver.js';
import { resolveWorkflowTrustInfo, type WorkflowTrustInfo } from './workflowTrustSource.js';

interface LoadWorkflowFromFileOptions {
  trustInfo?: WorkflowTrustInfo;
  callableArgs?: Record<string, string | string[]>;
  callableArgPolicy?: WorkflowCallArgResolutionPolicy;
}

type WorkflowLoadMode = 'runtime' | 'discovery';

function issueReviewerAnomalyDefinitionCapability(
  config: WorkflowConfig,
  filePath: string,
  trustInfo: WorkflowTrustInfo,
  opaqueRef: string,
): void {
  const attestation = config.subworkflow?.attestation;
  if (attestation === undefined) {
    return;
  }
  if (trustInfo.source !== 'builtin') {
    throw new Error(
      `Workflow "${config.name}" requests reviewer anomaly acknowledgement attestation from untrusted source "${trustInfo.source}"`,
    );
  }
  if (trustInfo.sourcePath === undefined) {
    throw new Error(`Builtin workflow "${config.name}" is missing trusted sourcePath metadata`);
  }
  const realFilePath = realpathSync(filePath);
  const realTrustSourcePath = realpathSync(trustInfo.sourcePath);
  if (realFilePath !== realTrustSourcePath || !isBuiltinWorkflowPath(realFilePath)) {
    throw new Error(
      `Builtin workflow "${config.name}" attestation source does not match a real builtin workflow file`,
    );
  }
  storeReviewerAnomalyDefinitionCapability(config, {
    kind: attestation.kind,
    approvalSteps: attestation.approvalSteps,
    workflowRef: opaqueRef,
  });
}

function loadWorkflowFromFileInternal(
  filePath: string,
  projectDir: string,
  options: LoadWorkflowFromFileOptions | undefined,
  loadMode: WorkflowLoadMode,
): WorkflowConfig {
  if (!existsSync(filePath)) {
    throw new Error(`Workflow file not found: ${filePath}`);
  }

  const raw = parseYaml(readFileSync(filePath, 'utf-8'));
  const workflowDir = dirname(filePath);
  const context: FacetResolutionContext = {
    lang: resolveWorkflowConfigValue(projectDir, 'language'),
    projectDir,
    workflowDir,
    repertoireDir: getRepertoireDir(),
  };

  const projectConfig = loadProjectConfig(projectDir);
  const globalConfig = loadGlobalConfig();
  const trustInfo = options?.trustInfo ?? resolveWorkflowTrustInfo({
    filePath,
    projectCwd: projectDir,
  });

  const config = normalizeWorkflowConfig(
    raw,
    workflowDir,
    context,
    projectConfig.workflowOverrides,
    globalConfig.workflowOverrides,
    resolveWorkflowRuntimePreparePolicy(globalConfig.workflowRuntimePrepare, projectConfig.workflowRuntimePrepare),
    resolveWorkflowArpeggioPolicy(globalConfig.workflowArpeggio, projectConfig.workflowArpeggio),
    resolveWorkflowMcpServersPolicy(globalConfig.workflowMcpServers, projectConfig.workflowMcpServers),
    options?.callableArgs,
    options?.callableArgPolicy,
    loadMode,
    resolveWorkflowCommandGatesPolicy(globalConfig.workflowCommandGates, projectConfig.workflowCommandGates),
  );
  const opaqueRef = buildOpaqueWorkflowRef(filePath, trustInfo);
  issueWorkflowOpaqueRef(config, opaqueRef);
  attachWorkflowSourcePath(config, filePath);
  attachWorkflowTrustInfo(config, trustInfo);
  issueReviewerAnomalyDefinitionCapability(config, filePath, trustInfo, opaqueRef);
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
