import { confirm } from '../../../shared/prompt/index.js';
import { getLabel } from '../../../shared/i18n/index.js';
import { createLogger, getErrorMessage } from '../../../shared/utils/index.js';
import { warn } from '../../../shared/ui/index.js';
import { isWorkflowPath, loadAllStandaloneWorkflowsWithSources, loadWorkflowByIdentifier } from '../../../infra/config/index.js';
import { buildAutoRequeueNote } from '../../../infra/task/index.js';
import { selectWorkflow } from '../../workflowSelection/index.js';
import { parse as parseYaml } from 'yaml';
import {
  selectRun,
  loadRunSessionContext,
  listRecentRuns,
  type RunSessionContext,
} from '../../interactive/index.js';

const log = createLogger('list-tasks');
export const DEPRECATED_PROVIDER_CONFIG_WARNING =
  'Detected deprecated provider config in selected run order.md. Please migrate legacy fields to the provider block.';

export function resolveSelectedWorkflowOverride(
  previousWorkflow: string | undefined,
  selectedWorkflow: string,
): string | undefined {
  return previousWorkflow === selectedWorkflow ? undefined : selectedWorkflow;
}

export function appendRetryNote(existing: string | undefined, additional: string): string {
  const trimmedAdditional = additional.trim();
  if (trimmedAdditional === '') {
    throw new Error('Additional instruction is empty.');
  }
  if (!existing || existing.trim() === '') {
    return trimmedAdditional;
  }
  return `${existing}\n\n${trimmedAdditional}`;
}

export { buildAutoRequeueNote };

function resolveReusableWorkflowName(
  previousWorkflow: string | undefined,
  projectDir: string,
  lookupCwd: string,
): string | null {
  const workflow = previousWorkflow?.trim();
  if (!workflow) {
    return null;
  }
  if (isWorkflowPath(workflow)) {
    try {
      return loadWorkflowByIdentifier(workflow, projectDir, { lookupCwd }) ? workflow : null;
    } catch (error) {
      warn(`Previous workflow could not be reused: ${getErrorMessage(error)}`);
      return null;
    }
  }
  const availableWorkflows = loadAllStandaloneWorkflowsWithSources(projectDir, { onWarning: warn });
  if (!availableWorkflows.has(workflow)) {
    return null;
  }
  return workflow;
}

export async function selectWorkflowWithOptionalReuse(
  projectDir: string,
  previousWorkflow: string | undefined,
  lookupCwd: string,
  lang?: 'en' | 'ja',
): Promise<string | null> {
  const reusableWorkflow = resolveReusableWorkflowName(previousWorkflow, projectDir, lookupCwd);
  if (reusableWorkflow) {
    const shouldReusePreviousWorkflow = await confirm(
      getLabel('retry.usePreviousWorkflowConfirm', lang, { workflow: reusableWorkflow }),
      true,
    );
    if (shouldReusePreviousWorkflow) {
      return reusableWorkflow;
    }
  }

  return selectWorkflow(projectDir);
}

function extractYamlCandidates(content: string): string[] {
  const blockPattern = /```(?:yaml|yml)\s*\n([\s\S]*?)```/gi;
  const candidates = Array.from(content.matchAll(blockPattern), (match) => match[1])
    .filter((candidate): candidate is string => typeof candidate === 'string' && candidate !== '');
  return candidates.length > 0 ? candidates : [content];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isWorkflowConfigLike(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && Array.isArray(value.steps);
}

const MAX_PROVIDER_SCAN_NODES = 10000;

interface DeprecatedProviderConfigScanState {
  visited: readonly object[];
  visitedNodes: number;
}

interface DeprecatedProviderConfigScanResult {
  found: boolean;
  state: DeprecatedProviderConfigScanState;
}

function hasDeprecatedProviderConfigInObject(
  value: unknown,
  state: DeprecatedProviderConfigScanState,
): DeprecatedProviderConfigScanResult {
  let nextVisited = state.visited;
  if (isRecord(value)) {
    if (nextVisited.includes(value)) {
      return { found: false, state };
    }
    nextVisited = [...nextVisited, value];
  }

  const nextState = {
    visited: nextVisited,
    visitedNodes: state.visitedNodes + 1,
  };
  if (nextState.visitedNodes > MAX_PROVIDER_SCAN_NODES) {
    return { found: false, state: nextState };
  }

  if (Array.isArray(value)) {
    let currentState = nextState;
    for (const item of value) {
      const result = hasDeprecatedProviderConfigInObject(item, currentState);
      if (result.found) {
        return result;
      }
      currentState = result.state;
    }
    return { found: false, state: currentState };
  }
  if (!isRecord(value)) {
    return { found: false, state: nextState };
  }

  if ('provider_options' in value) {
    return { found: true, state: nextState };
  }
  if (isRecord(value.provider) && typeof value.model === 'string') {
    return { found: true, state: nextState };
  }

  let currentState = nextState;
  for (const entry of Object.values(value)) {
    const result = hasDeprecatedProviderConfigInObject(entry, currentState);
    if (result.found) {
      return result;
    }
    currentState = result.state;
  }

  return { found: false, state: currentState };
}

export function hasDeprecatedProviderConfig(orderContent: string | null): boolean {
  if (!orderContent) {
    return false;
  }

  const yamlCandidates = extractYamlCandidates(orderContent);
  for (const candidate of yamlCandidates) {
    let parsed: unknown;
    try {
      parsed = parseYaml(candidate);
    } catch (error) {
      log.debug('Failed to parse YAML candidate for deprecated provider config detection', {
        error: getErrorMessage(error),
      });
      continue;
    }
    if (
      isWorkflowConfigLike(parsed)
      && hasDeprecatedProviderConfigInObject(parsed, { visited: [], visitedNodes: 0 }).found
    ) {
      return true;
    }
  }
  return false;
}

export async function selectRunSessionContext(
  projectDir: string,
  lang: 'en' | 'ja',
): Promise<RunSessionContext | undefined> {
  if (listRecentRuns(projectDir).length === 0) {
    return undefined;
  }

  const shouldReferenceRun = await confirm(
    getLabel('interactive.runSelector.confirm', lang),
    false,
  );
  if (!shouldReferenceRun) {
    return undefined;
  }

  const selectedSlug = await selectRun(projectDir, lang);
  if (!selectedSlug) {
    return undefined;
  }

  return loadRunSessionContext(projectDir, selectedSlug);
}
