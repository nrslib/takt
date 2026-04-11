import { dirname } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
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
  resolveWorkflowMcpServersPolicy,
  resolveWorkflowRuntimePreparePolicy,
} from './workflowNormalizationPolicies.js';

export function loadWorkflowFromFile(filePath: string, projectDir: string): WorkflowConfig {
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

  const config = normalizeWorkflowConfig(
    raw,
    workflowDir,
    context,
    projectConfig.workflowOverrides,
    globalConfig.workflowOverrides,
    resolveWorkflowRuntimePreparePolicy(globalConfig.workflowRuntimePrepare, projectConfig.workflowRuntimePrepare),
    resolveWorkflowArpeggioPolicy(globalConfig.workflowArpeggio, projectConfig.workflowArpeggio),
    resolveWorkflowMcpServersPolicy(globalConfig.workflowMcpServers, projectConfig.workflowMcpServers),
    filePath,
  );
  return config;
}
