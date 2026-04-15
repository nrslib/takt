import type { z } from 'zod/v4';
import type { WorkflowCallArgValue } from '../../../core/models/index.js';
import { WorkflowConfigRawSchema } from '../../../core/models/index.js';

type RawWorkflowConfig = z.output<typeof WorkflowConfigRawSchema>;

const DISCOVERY_PLACEHOLDER_PREFIX = '__takt_discovery_param__';

const FACET_SECTION_BY_KIND = {
  knowledge: 'knowledge',
  policy: 'policies',
  instruction: 'instructions',
  report_format: 'report_formats',
} as const;

function buildPlaceholderRef(paramName: string, kind: keyof typeof FACET_SECTION_BY_KIND): string {
  return `${DISCOVERY_PLACEHOLDER_PREFIX}_${kind}_${paramName}`;
}

function buildPlaceholderContent(paramName: string, kind: keyof typeof FACET_SECTION_BY_KIND): string {
  return `[discovery placeholder for ${kind} param "${paramName}"]`;
}

function ensurePlaceholderFacet(
  raw: RawWorkflowConfig,
  paramName: string,
  kind: keyof typeof FACET_SECTION_BY_KIND,
): string {
  const sectionKey = FACET_SECTION_BY_KIND[kind];
  const existingSection = raw[sectionKey] ?? {};
  const placeholderRef = buildPlaceholderRef(paramName, kind);
  raw[sectionKey] = {
    ...existingSection,
    [placeholderRef]: existingSection[placeholderRef] ?? buildPlaceholderContent(paramName, kind),
  };
  return placeholderRef;
}

export function prepareCallableSubworkflowDiscoveryArgs(
  raw: RawWorkflowConfig,
): { raw: RawWorkflowConfig; callableArgs?: Record<string, WorkflowCallArgValue> } {
  if (raw.subworkflow?.callable !== true) {
    return { raw, callableArgs: undefined };
  }

  const params = raw.subworkflow.params;
  if (!params || Object.keys(params).length === 0) {
    return { raw, callableArgs: undefined };
  }

  const prepared = structuredClone(raw);
  const callableArgs = new Map<string, WorkflowCallArgValue>();

  for (const [paramName, definition] of Object.entries(params)) {
    if (definition.default !== undefined) {
      callableArgs.set(paramName, definition.default);
      continue;
    }

    const placeholderRef = ensurePlaceholderFacet(prepared, paramName, definition.facet_kind);
    callableArgs.set(
      paramName,
      definition.type === 'facet_ref[]' ? [placeholderRef] : placeholderRef,
    );
  }

  return {
    raw: prepared,
    callableArgs: Object.fromEntries(callableArgs),
  };
}
