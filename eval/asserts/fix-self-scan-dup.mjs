/**
 * Single implementation of the override semantics: the provider-switch
 * model-discard rule must live in exactly one module after the fix. A fix
 * that copy-pastes the precedence/discard conditional into the session or
 * summary seam duplicates the invariant.
 */
import { listSourceFiles, readSource, relPath, fail, pass } from './fix-self-scan-lib.mjs';

// The discard rule needs a comparison between two provider VALUES (the
// override/effective one and the configured one), so require a provider-ish
// identifier on BOTH sides of the comparison. This excludes type guards
// (`typeof provider !== 'string'`) and presence checks
// (`flags.provider !== undefined`), and the /i flag keeps camelCase
// spellings (`effectiveProvider !== configuredProvider`) in scope. Either
// polarity (`!==`/`===`, strict or loose) counts.
const PROVIDER_SWITCH_CHECK = /[\w.$]*provider\s*[!=]==?\s*[\w.$]*provider\b/i;

export default async function assertSingleOverrideImplementation() {
  const owners = [];
  for (const file of listSourceFiles()) {
    if (PROVIDER_SWITCH_CHECK.test(readSource(file))) owners.push(relPath(file));
  }
  if (owners.length === 0) {
    return fail('no module implements the provider-switch model-discard rule');
  }
  if (owners.length > 1) {
    return fail(`override semantics are duplicated across: ${owners.join(', ')}`);
  }
  return pass(`override semantics live in exactly one module: ${owners[0]}`);
}
