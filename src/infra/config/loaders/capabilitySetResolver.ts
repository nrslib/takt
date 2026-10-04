import type { StepProviderOptions } from '../../../core/models/workflow-types.js';
import type { FacetResolutionContext } from './resource-resolver.js';
import { mergeProviderOptions } from '../providerOptions.js';
import { resolveWorkflowProviderOptions } from './workflowProviderOptionsResolver.js';

const CAPABILITY_LEAF_KEYS: ReadonlySet<string> = new Set([
  'allowedTools',
  'networkAccess',
  'sandbox',
  'skills',
]);

export function assertCapabilitySetOptions(name: string, options: StepProviderOptions): void {
  for (const [providerKey, providerOptions] of Object.entries(options)) {
    if (providerOptions === undefined) {
      continue;
    }
    for (const leaf of Object.keys(providerOptions as Record<string, unknown>)) {
      if (!CAPABILITY_LEAF_KEYS.has(leaf)) {
        throw new Error(
          `Configuration error: capabilities "${name}" may only declare capability leaves `
          + '(allowed_tools, network_access, sandbox, skills), '
          + `but "${providerKey}.${leaf}" is not a capability leaf`,
        );
      }
    }
  }
}

/** Later names win on a leaf several sets declare. */
export function resolveCapabilitySets(
  names: string | readonly string[],
  workflowDir: string,
  context: FacetResolutionContext | undefined,
): StepProviderOptions {
  if (typeof names === 'string') {
    return resolveCapabilitySet(names, workflowDir, context);
  }
  const merged = mergeProviderOptions(
    ...names.map((name) => resolveCapabilitySet(name, workflowDir, context)),
  );
  if (merged === undefined) {
    throw new Error(
      `Configuration error: capabilities [${names.join(', ')}] resolved to no capability options`,
    );
  }
  return merged;
}

function resolveCapabilitySet(
  name: string,
  workflowDir: string,
  context: FacetResolutionContext | undefined,
): StepProviderOptions {
  let resolved: StepProviderOptions | undefined;
  try {
    resolved = resolveWorkflowProviderOptions({ extends: name }, workflowDir, context);
  } catch (error) {
    throw new Error(`Configuration error: failed to resolve capabilities "${name}"`, { cause: error });
  }
  if (resolved === undefined) {
    throw new Error(`Configuration error: capabilities "${name}" resolved to no capability options`);
  }
  assertCapabilitySetOptions(name, resolved);
  return resolved;
}
