import type { ResolvedCompanionDefinition, CompanionSelection } from '../../models/companion-types.js';
import { truncateUtf8 } from '../../../shared/utils/utf8.js';
import {
  createBoundedSensitiveValues,
  sanitizeSensitiveTextWithKnownValues,
} from '../../../shared/utils/sensitiveText.js';

const MAX_ACTIVE_COMPANIONS = 3;
const SELECTOR_RATIONALE_MAX_BYTES = 1024;

export function sanitizeCompanionSelectorRationale(rationale: string, source: unknown): string {
  const sensitiveValues = createBoundedSensitiveValues();
  sensitiveValues.collect(source);
  return truncateUtf8(
    sanitizeSensitiveTextWithKnownValues(rationale, sensitiveValues),
    SELECTOR_RATIONALE_MAX_BYTES,
  ).value;
}

export async function selectActiveCompanions(input: {
  selection: CompanionSelection;
  definitions: ReadonlyMap<string, Pick<ResolvedCompanionDefinition, 'name' | 'description'>>;
  task: string;
  stepContext: { name: string; instruction: string };
  runSelector: (request: {
    task: string;
    step: { name: string; instruction: string };
    candidates: Array<{ name: string; description: string }>;
    maxSelected: number;
  }) => Promise<{ selectedIds: string[]; rationale: string }>;
}): Promise<Array<Pick<ResolvedCompanionDefinition, 'name' | 'description'>>> {
  const fixedNames = unique(input.selection.fixed);
  const fixed = fixedNames.map((name) => requireDefinition(name, input.definitions));
  if (fixed.length > MAX_ACTIVE_COMPANIONS) {
    throw new Error(`Companion selection exceeds maximum ${MAX_ACTIVE_COMPANIONS}`);
  }
  const poolNames = unique(input.selection.pool).filter((name) => !fixedNames.includes(name));
  if (poolNames.length === 0) return fixed;
  const candidates = poolNames.map((name) => requireDefinition(name, input.definitions));
  const selected = await input.runSelector({
    task: input.task,
    step: { ...input.stepContext },
    candidates: candidates.map(({ name, description }) => ({ name, description })),
    maxSelected: MAX_ACTIVE_COMPANIONS - fixed.length,
  });
  const names = unique([...fixedNames, ...selected.selectedIds]);
  return names.map((name) => requireDefinition(name, input.definitions));
}

function unique(names: readonly string[]): string[] {
  return [...new Set(names)];
}

function requireDefinition<T extends { name: string }>(
  name: string,
  definitions: ReadonlyMap<string, T>,
): T {
  const definition = definitions.get(name);
  if (definition === undefined) throw new Error(`Undefined companion "${name}"`);
  return definition;
}
