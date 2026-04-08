import { confirm } from '../../../shared/prompt/index.js';
import { getLabel } from '../../../shared/i18n/index.js';
import { createLogger, getErrorMessage } from '../../../shared/utils/index.js';
import { warn } from '../../../shared/ui/index.js';
import { isWorkflowPath, loadAllWorkflowsWithSources } from '../../../infra/config/index.js';
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

function resolveReusableWorkflowName(
  previousWorkflow: string | undefined,
  projectDir: string,
): string | null {
  if (!previousWorkflow || previousWorkflow.trim() === '') {
    return null;
  }
  if (isWorkflowPath(previousWorkflow)) {
    return null;
  }
  const availableWorkflows = loadAllWorkflowsWithSources(projectDir, { onWarning: warn });
  if (!availableWorkflows.has(previousWorkflow)) {
    return null;
  }
  return previousWorkflow;
}

export async function selectWorkflowWithOptionalReuse(
  projectDir: string,
  previousWorkflow: string | undefined,
  lang?: 'en' | 'ja',
): Promise<string | null> {
  const reusableWorkflow = resolveReusableWorkflowName(previousWorkflow, projectDir);
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
  const candidates: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = blockPattern.exec(content)) !== null) {
    if (match[1]) {
      candidates.push(match[1]);
    }
  }
  if (candidates.length > 0) {
    return candidates;
  }
  return [content];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isWorkflowConfigLike(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && Array.isArray(value.steps);
}

const MAX_PROVIDER_SCAN_NODES = 10000;

function hasDeprecatedProviderConfigInObject(
  value: unknown,
  visited: WeakSet<object>,
  state: { visitedNodes: number },
): boolean {
  if (isRecord(value)) {
    if (visited.has(value)) {
      return false;
    }
    visited.add(value);
  }

  state.visitedNodes += 1;
  if (state.visitedNodes > MAX_PROVIDER_SCAN_NODES) {
    return false;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      if (hasDeprecatedProviderConfigInObject(item, visited, state)) {
        return true;
      }
    }
    return false;
  }
  if (!isRecord(value)) {
    return false;
  }

  if ('provider_options' in value) {
    return true;
  }
  if (isRecord(value.provider) && typeof value.model === 'string') {
    return true;
  }

  for (const entry of Object.values(value)) {
    if (hasDeprecatedProviderConfigInObject(entry, visited, state)) {
      return true;
    }
  }

  return false;
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
      && hasDeprecatedProviderConfigInObject(parsed, new WeakSet<object>(), { visitedNodes: 0 })
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
