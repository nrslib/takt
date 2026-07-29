import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { collectStepFragmentUses, isRecord } from '../../infra/config/loaders/workflowStepFragmentReader.js';
import { sanitizeTerminalText } from '../../shared/utils/text.js';
import { STEP_FRAGMENT_EXTENSIONS } from './file-filter.js';

interface FragmentSource {
  content: string;
  path: string;
}

interface StepFragmentIntegrityOptions {
  sources: readonly FragmentSource[];
  packageRoot: string;
  copiedStepNames: ReadonlySet<string>;
  owner: string;
  repo: string;
}

function collectWorkflowUses(value: unknown, refs: Set<string>): void {
  if (!isRecord(value) || !Array.isArray(value.steps)) return;
  for (const step of value.steps) collectStepFragmentUses(step, refs);
}

function assertSourceReferencesAreCopied(source: FragmentSource, options: StepFragmentIntegrityOptions): void {
  const refs = new Set<string>();
  try {
    const parsed = parseYaml(source.content);
    if (source.path.startsWith('workflows/')) {
      collectWorkflowUses(parsed, refs);
    } else {
      collectStepFragmentUses(parsed, refs);
    }
  } catch (error) {
    throw new Error(`Configuration error in repertoire source ${sanitizeTerminalText(source.path)}: failed to inspect step fragment references`, { cause: error });
  }
  for (const ref of refs) {
    const selfScopedPrefix = `@${options.owner}/${options.repo}/`;
    const localName = ref.startsWith(selfScopedPrefix) ? ref.slice(selfScopedPrefix.length) : ref;
    if (localName.includes('/') || localName.includes('\\')) continue;
    const paths = STEP_FRAGMENT_EXTENSIONS.map((extension) => (
      join(options.packageRoot, 'steps', `${localName}${extension}`)
    ));
    if (paths.some((path) => existsSync(path)) && !options.copiedStepNames.has(localName)) {
      throw new Error(`Step fragment "${sanitizeTerminalText(localName)}" referenced by ${sanitizeTerminalText(source.path)} is excluded from package installation`);
    }
  }
}

export function assertCopiedStepFragmentReferences(options: StepFragmentIntegrityOptions): void {
  for (const source of options.sources) assertSourceReferencesAreCopied(source, options);
}
