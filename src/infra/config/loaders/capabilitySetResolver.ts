/**
 * Capability-set resolution (issue #1208 Stage 1).
 *
 * A `capabilities:` reference names an existing provider-options named resource, formalized as a
 * capability-set. Resolution reuses the provider-options resolver (4-layer lookup, `@owner/repo/name`
 * references, realpath cycle detection, upward-layer sealing) via its `extends` entry point, then
 * purifies the result: through the `capabilities:` path only capability leaves are permitted
 * (`allowed_tools` / `network_access` / `sandbox` / `skills`). Any quality/cost or machine-specific
 * leaf (effort, base_url, guards, variant, …) fails fast at load time — those belong in runtime.yaml,
 * not in a workflow's capability declaration. The legacy `provider_options.extends` path keeps
 * accepting every leaf and runs unchanged (Stage 1 parallel run; purification is capabilities-only).
 */

import type { StepProviderOptions } from '../../../core/models/workflow-types.js';
import type { FacetResolutionContext } from './resource-resolver.js';
import { resolveWorkflowProviderOptions } from './workflowProviderOptionsResolver.js';

/** Normalized (camelCase) leaf keys that a capability-set may declare. */
const CAPABILITY_LEAF_KEYS: ReadonlySet<string> = new Set([
  'allowedTools',
  'networkAccess',
  'sandbox',
  'skills',
]);

function assertCapabilityLeavesOnly(name: string, options: StepProviderOptions): void {
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

/**
 * Resolve a `capabilities:` reference into a purified provider-options bundle. Throws when the
 * reference cannot be resolved, resolves to nothing, or carries a non-capability leaf.
 */
export function resolveCapabilitySet(
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
  assertCapabilityLeavesOnly(name, resolved);
  return resolved;
}
