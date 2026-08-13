import {
  formatPropertyPath,
  getOwnValue,
  isPlainObject,
  type RawRecord,
  workflowError,
} from './workflowStepFragmentReader.js';

type FragmentParamType = 'facet_ref' | 'facet_ref[]' | 'workflow_ref' | 'facet_pool_ref';
type FragmentFacetKind = 'policy' | 'knowledge' | 'instruction' | 'persona' | 'report_format';
type FragmentParamValue = string | string[] | FragmentParamReference;

interface FragmentParamReference {
  readonly $param: string;
}

export type FragmentParamDeclaration =
  | {
      readonly type: 'facet_ref' | 'facet_ref[]';
      readonly facetKind: FragmentFacetKind;
    }
  | {
      readonly type: 'workflow_ref';
      readonly facetKind?: never;
    }
  | {
      readonly type: 'facet_pool_ref';
      readonly facetKind?: never;
    };

export interface BindStepFragmentParamsOptions {
  readonly callerPath: readonly PropertyKey[];
  readonly callerSourcePath: string;
  readonly fragmentPath: string;
  readonly outerParams: ReadonlyMap<string, FragmentParamDeclaration>;
  readonly workflowPath: string;
  readonly boundPaths?: Array<readonly PropertyKey[]>;
}

export interface BoundStepFragment {
  readonly boundPaths: readonly (readonly PropertyKey[])[];
  readonly value: RawRecord;
}

interface FieldContract {
  readonly kinds?: readonly FragmentFacetKind[];
  readonly types: readonly FragmentParamType[];
}

interface ResolvedFragmentBinding {
  readonly declaration: FragmentParamDeclaration;
  readonly value: FragmentParamValue;
}

export interface BoundStepFragmentSource {
  readonly path: readonly PropertyKey[];
  readonly sourcePath: string;
}

const PASS_THROUGH_BINDINGS = new WeakMap<RawRecord, ResolvedFragmentBinding>();
const BOUND_STEP_FRAGMENT_SOURCES = new WeakMap<RawRecord, BoundStepFragmentSource>();
const PARAM_TYPES = new Set<FragmentParamType>(['facet_ref', 'facet_ref[]', 'workflow_ref', 'facet_pool_ref']);
const FACET_KINDS = new Set<FragmentFacetKind>(['policy', 'knowledge', 'instruction', 'persona', 'report_format']);
const POLICY_CONTRACT: FieldContract = {
  kinds: ['policy'],
  types: ['facet_ref', 'facet_ref[]'],
};
const KNOWLEDGE_CONTRACT: FieldContract = {
  kinds: ['knowledge'],
  types: ['facet_ref', 'facet_ref[]'],
};
const INSTRUCTION_CONTRACT: FieldContract = {
  kinds: ['instruction'],
  types: ['facet_ref'],
};
const PERSONA_CONTRACT: FieldContract = {
  kinds: ['persona'],
  types: ['facet_ref'],
};
const REPORT_FORMAT_CONTRACT: FieldContract = {
  kinds: ['report_format'],
  types: ['facet_ref'],
};
const WORKFLOW_CALL_ARG_CONTRACT: FieldContract = {
  kinds: ['policy', 'knowledge', 'instruction', 'persona', 'report_format'],
  types: ['facet_ref', 'facet_ref[]', 'workflow_ref', 'facet_pool_ref'],
};
const WORKFLOW_REFERENCE_CONTRACT: FieldContract = {
  types: ['workflow_ref'],
};

function fragmentError(
  options: BindStepFragmentParamsOptions,
  path: readonly PropertyKey[],
  message: string,
): Error {
  return workflowError(options.workflowPath, message, {
    path,
    sourcePath: options.fragmentPath,
  });
}

function callerError(
  options: BindStepFragmentParamsOptions,
  path: readonly PropertyKey[],
  message: string,
): Error {
  return workflowError(options.workflowPath, message, {
    path,
    sourcePath: options.callerSourcePath,
  });
}

function parseParamReference(
  value: unknown,
  options: BindStepFragmentParamsOptions,
  path: readonly PropertyKey[],
  source: 'caller' | 'fragment',
): FragmentParamReference | undefined {
  if (!isPlainObject(value) || !Object.hasOwn(value, '$param')) return undefined;
  const fail = source === 'caller' ? callerError : fragmentError;
  const name = getOwnValue(value, '$param');
  if (Object.keys(value).length !== 1 || typeof name !== 'string' || name.length === 0) {
    throw fail(options, path, `invalid parameter reference at ${formatPropertyPath(path)}`);
  }
  return { $param: name };
}

function parseDeclaration(
  name: string,
  value: unknown,
  options: BindStepFragmentParamsOptions,
): FragmentParamDeclaration {
  const path = ['params', name];
  if (!isPlainObject(value)) {
    throw fragmentError(options, path, `fragment param "${name}" must be an object`);
  }
  const keys = Object.keys(value);
  const unknownKey = keys.find((key) => key !== 'type' && key !== 'facet_kind');
  if (unknownKey !== undefined) {
    throw fragmentError(
      options,
      [...path, unknownKey],
      `fragment param "${name}" contains unsupported property "${unknownKey}"`,
    );
  }
  const type = getOwnValue(value, 'type');
  if (typeof type !== 'string' || !PARAM_TYPES.has(type as FragmentParamType)) {
    throw fragmentError(options, [...path, 'type'], `fragment param "${name}" has an invalid type`);
  }
  const facetKind = getOwnValue(value, 'facet_kind');
  if (type === 'workflow_ref' || type === 'facet_pool_ref') {
    if (facetKind !== undefined) {
      throw fragmentError(
        options,
        [...path, 'facet_kind'],
        `fragment param "${name}" does not allow facet_kind for ${type}`,
      );
    }
    return { type };
  }
  if (typeof facetKind !== 'string' || !FACET_KINDS.has(facetKind as FragmentFacetKind)) {
    throw fragmentError(
      options,
      [...path, 'facet_kind'],
      `fragment param "${name}" has an invalid facet_kind`,
    );
  }
  return {
    type: type as 'facet_ref' | 'facet_ref[]',
    facetKind: facetKind as FragmentFacetKind,
  };
}

function parseFragmentDeclarations(
  fragment: RawRecord,
  options: BindStepFragmentParamsOptions,
): ReadonlyMap<string, FragmentParamDeclaration> {
  const rawParams = getOwnValue(fragment, 'params');
  if (rawParams === undefined) return new Map();
  if (!isPlainObject(rawParams)) {
    throw fragmentError(options, ['params'], 'step fragment params must be an object');
  }
  const declarations = new Map<string, FragmentParamDeclaration>();
  for (const [name, declaration] of Object.entries(rawParams)) {
    if (name.length === 0) {
      throw fragmentError(options, ['params', name], 'step fragment param names must be non-empty');
    }
    declarations.set(name, parseDeclaration(name, declaration, options));
  }
  return declarations;
}

function validateLiteralBinding(
  name: string,
  declaration: FragmentParamDeclaration,
  value: unknown,
  options: BindStepFragmentParamsOptions,
  path: readonly PropertyKey[],
): string | string[] {
  if (declaration.type === 'facet_ref') {
    if (typeof value !== 'string' || value.length === 0) {
      throw callerError(options, path, `fragment param "${name}" requires a scalar facet reference`);
    }
    return value;
  }
  if (declaration.type === 'workflow_ref' || declaration.type === 'facet_pool_ref') {
    if (typeof value !== 'string' || value.length === 0) {
      throw callerError(
        options,
        path,
        `fragment param "${name}" requires a scalar ${declaration.type === 'workflow_ref' ? 'workflow' : 'facet pool'} reference`,
      );
    }
    return value;
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
    throw callerError(options, path, `fragment param "${name}" requires a facet reference array`);
  }
  return [...value] as string[];
}

function resolveBinding(
  name: string,
  declaration: FragmentParamDeclaration,
  value: unknown,
  options: BindStepFragmentParamsOptions,
  path: readonly PropertyKey[],
): ResolvedFragmentBinding {
  if (isPlainObject(value)) {
    const passThrough = PASS_THROUGH_BINDINGS.get(value);
    if (passThrough) {
      if (passThrough.declaration.type !== declaration.type) {
        throw callerError(options, path, `fragment param "${name}" has incompatible cardinality`);
      }
      if (passThrough.declaration.facetKind !== declaration.facetKind) {
        throw callerError(options, path, `fragment param "${name}" has incompatible facet kind`);
      }
      return {
        declaration,
        value: passThrough.value,
      };
    }
  }
  const reference = parseParamReference(value, options, path, 'caller');
  if (!reference) {
    return {
      declaration,
      value: validateLiteralBinding(name, declaration, value, options, path),
    };
  }
  const outerDeclaration = options.outerParams.get(reference.$param);
  if (!outerDeclaration) {
    throw callerError(
      options,
      path,
      `fragment binding references undeclared outer param "${reference.$param}"`,
    );
  }
  if (outerDeclaration.type !== declaration.type) {
    throw callerError(options, path, `fragment param "${name}" has incompatible cardinality`);
  }
  if (outerDeclaration.facetKind !== declaration.facetKind) {
    throw callerError(options, path, `fragment param "${name}" has incompatible facet kind`);
  }
  return {
    declaration,
    value: reference,
  };
}

function resolveBindings(
  caller: RawRecord,
  declarations: ReadonlyMap<string, FragmentParamDeclaration>,
  options: BindStepFragmentParamsOptions,
): ReadonlyMap<string, ResolvedFragmentBinding> {
  const rawWith = getOwnValue(caller, 'with');
  const withPath = [...options.callerPath, 'with'];
  if (rawWith !== undefined && !isPlainObject(rawWith)) {
    throw callerError(options, withPath, `fragment bindings at ${formatPropertyPath(withPath)} must be an object`);
  }
  const bindings = rawWith ?? {};
  for (const name of Object.keys(bindings)) {
    if (!declarations.has(name)) {
      throw callerError(options, [...withPath, name], `unknown fragment param "${name}"`);
    }
  }
  const resolved = new Map<string, ResolvedFragmentBinding>();
  for (const [name, declaration] of declarations) {
    if (!Object.hasOwn(bindings, name)) {
      throw callerError(options, [...withPath, name], `missing required fragment param "${name}"`);
    }
    resolved.set(
      name,
      resolveBinding(name, declaration, bindings[name], options, [...withPath, name]),
    );
  }
  return resolved;
}

function substituteParam(
  value: unknown,
  contract: FieldContract,
  declarations: ReadonlyMap<string, FragmentParamDeclaration>,
  bindings: ReadonlyMap<string, ResolvedFragmentBinding>,
  options: BindStepFragmentParamsOptions,
  path: readonly PropertyKey[],
): unknown {
  const reference = parseParamReference(value, options, path, 'fragment');
  if (!reference) {
    assertNoParamReferences(value, options, path);
    return value;
  }
  const declaration = declarations.get(reference.$param);
  if (!declaration) {
    throw fragmentError(options, path, `fragment references undeclared param "${reference.$param}"`);
  }
  if (!contract.types.includes(declaration.type)) {
    throw fragmentError(options, path, `fragment param "${reference.$param}" has incompatible cardinality`);
  }
  if (declaration.type !== 'workflow_ref' && declaration.type !== 'facet_pool_ref' && contract.kinds !== undefined && (
    declaration.facetKind === undefined
    || !contract.kinds.includes(declaration.facetKind)
  )) {
    throw fragmentError(options, path, `fragment param "${reference.$param}" has incompatible facet kind`);
  }
  options.boundPaths?.push(path);
  return bindings.get(reference.$param)?.value;
}

function substituteFacetList(
  value: unknown,
  contract: FieldContract,
  declarations: ReadonlyMap<string, FragmentParamDeclaration>,
  bindings: ReadonlyMap<string, ResolvedFragmentBinding>,
  options: BindStepFragmentParamsOptions,
  path: readonly PropertyKey[],
): unknown {
  if (!Array.isArray(value)) {
    return substituteParam(value, contract, declarations, bindings, options, path);
  }
  return value.flatMap((entry, index) => {
    const substituted = substituteParam(
      entry,
      contract,
      declarations,
      bindings,
      options,
      [...path, index],
    );
    return Array.isArray(substituted) ? substituted : [substituted];
  });
}

function substitutePassThrough(
  value: unknown,
  declarations: ReadonlyMap<string, FragmentParamDeclaration>,
  bindings: ReadonlyMap<string, ResolvedFragmentBinding>,
  options: BindStepFragmentParamsOptions,
  path: readonly PropertyKey[],
): unknown {
  const reference = parseParamReference(value, options, path, 'fragment');
  if (!reference) {
    assertNoParamReferences(value, options, path);
    return value;
  }
  if (!declarations.has(reference.$param)) {
    throw fragmentError(options, path, `fragment references undeclared param "${reference.$param}"`);
  }
  const binding = bindings.get(reference.$param);
  if (!binding) {
    throw fragmentError(options, path, `fragment param "${reference.$param}" has no resolved binding`);
  }
  const passThrough: RawRecord = {};
  PASS_THROUGH_BINDINGS.set(passThrough, binding);
  return passThrough;
}

function assertNoParamReferences(
  value: unknown,
  options: BindStepFragmentParamsOptions,
  path: readonly PropertyKey[],
): void {
  const reference = parseParamReference(value, options, path, 'fragment');
  if (reference) {
    throw fragmentError(options, path, `parameter reference is not supported at ${formatPropertyPath(path)}`);
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoParamReferences(entry, options, [...path, index]));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    assertNoParamReferences(nested, options, [...path, key]);
  }
}

function bindOutputContracts(
  value: unknown,
  declarations: ReadonlyMap<string, FragmentParamDeclaration>,
  bindings: ReadonlyMap<string, ResolvedFragmentBinding>,
  options: BindStepFragmentParamsOptions,
  path: readonly PropertyKey[],
): unknown {
  if (!isPlainObject(value)) {
    assertNoParamReferences(value, options, path);
    return value;
  }
  const report = getOwnValue(value, 'report');
  const expandedReport = Array.isArray(report)
    ? report.map((entry, index) => {
      if (!isPlainObject(entry)) {
        assertNoParamReferences(entry, options, [...path, 'report', index]);
        return entry;
      }
      const expandedEntry = { ...entry };
      for (const [key, nested] of Object.entries(entry)) {
        const nestedPath = [...path, 'report', index, key];
        expandedEntry[key] = key === 'format'
          ? substituteParam(nested, REPORT_FORMAT_CONTRACT, declarations, bindings, options, nestedPath)
          : (assertNoParamReferences(nested, options, nestedPath), nested);
      }
      return expandedEntry;
    })
    : report;
  if (!Array.isArray(report)) {
    assertNoParamReferences(report, options, [...path, 'report']);
  }
  for (const [key, nested] of Object.entries(value)) {
    if (key !== 'report') assertNoParamReferences(nested, options, [...path, key]);
  }
  return { ...value, report: expandedReport };
}

function bindWorkflowCallArgs(
  value: unknown,
  declarations: ReadonlyMap<string, FragmentParamDeclaration>,
  bindings: ReadonlyMap<string, ResolvedFragmentBinding>,
  options: BindStepFragmentParamsOptions,
  path: readonly PropertyKey[],
): unknown {
  if (!isPlainObject(value)) {
    assertNoParamReferences(value, options, path);
    return value;
  }
  return Object.fromEntries(Object.entries(value).map(([name, binding]) => [
    name,
    substituteParam(
      binding,
      WORKFLOW_CALL_ARG_CONTRACT,
      declarations,
      bindings,
      options,
      [...path, name],
    ),
  ]));
}

function bindDynamicFacets(
  value: unknown,
  declarations: ReadonlyMap<string, FragmentParamDeclaration>,
  bindings: ReadonlyMap<string, ResolvedFragmentBinding>,
  options: BindStepFragmentParamsOptions,
  path: readonly PropertyKey[],
): unknown {
  if (!isPlainObject(value)) {
    assertNoParamReferences(value, options, path);
    return value;
  }

  const poolPath = [...path, 'pool'];
  const reference = parseParamReference(getOwnValue(value, 'pool'), options, poolPath, 'fragment');
  if (!reference) {
    assertNoParamReferences(value, options, path);
    return value;
  }

  const declaration = declarations.get(reference.$param) ?? options.outerParams.get(reference.$param);
  if (!declaration) {
    throw fragmentError(options, poolPath, `fragment references undeclared param "${reference.$param}"`);
  }
  if (declaration.type !== 'facet_pool_ref') {
    throw fragmentError(options, poolPath, `fragment param "${reference.$param}" must be a facet_pool_ref`);
  }

  const localBinding = bindings.get(reference.$param);
  options.boundPaths?.push(poolPath);
  if (!localBinding) {
    return value;
  }
  return { ...value, pool: localBinding.value };
}

function bindStepFields(
  step: RawRecord,
  declarations: ReadonlyMap<string, FragmentParamDeclaration>,
  bindings: ReadonlyMap<string, ResolvedFragmentBinding>,
  options: BindStepFragmentParamsOptions,
  path: readonly PropertyKey[],
): RawRecord {
  const expanded: RawRecord = {};
  for (const [key, value] of Object.entries(step)) {
    const fieldPath = [...path, key];
    switch (key) {
      case 'params':
        if (path.length > 0) {
          throw fragmentError(options, fieldPath, 'step fragment params are only allowed at the fragment root');
        }
        break;
      case 'policy':
        expanded[key] = substituteFacetList(value, POLICY_CONTRACT, declarations, bindings, options, fieldPath);
        break;
      case 'knowledge':
        expanded[key] = substituteFacetList(value, KNOWLEDGE_CONTRACT, declarations, bindings, options, fieldPath);
        break;
      case 'instruction':
        expanded[key] = substituteParam(value, INSTRUCTION_CONTRACT, declarations, bindings, options, fieldPath);
        break;
      case 'review_completion': {
        if (!isPlainObject(value)) {
          assertNoParamReferences(value, options, fieldPath);
          expanded[key] = value;
          break;
        }
        const reviewCompletion: RawRecord = {};
        for (const [option, optionValue] of Object.entries(value)) {
          const optionPath = [...fieldPath, option];
          if (option === 'retry_instruction') {
            reviewCompletion[option] = substituteParam(
              optionValue,
              INSTRUCTION_CONTRACT,
              declarations,
              bindings,
              options,
              optionPath,
            );
          } else {
            assertNoParamReferences(optionValue, options, optionPath);
            reviewCompletion[option] = optionValue;
          }
        }
        expanded[key] = reviewCompletion;
        break;
      }
      case 'persona':
        expanded[key] = substituteParam(value, PERSONA_CONTRACT, declarations, bindings, options, fieldPath);
        break;
      case 'call':
        expanded[key] = substituteParam(value, WORKFLOW_REFERENCE_CONTRACT, declarations, bindings, options, fieldPath);
        break;
      case 'output_contracts':
        expanded[key] = bindOutputContracts(value, declarations, bindings, options, fieldPath);
        break;
      case 'args':
        expanded[key] = bindWorkflowCallArgs(value, declarations, bindings, options, fieldPath);
        break;
      case 'dynamic_facets':
        expanded[key] = bindDynamicFacets(value, declarations, bindings, options, fieldPath);
        break;
      case 'with':
        if (typeof getOwnValue(step, 'uses') !== 'string' || !isPlainObject(value)) {
          throw fragmentError(options, fieldPath, 'fragment with bindings require a nested uses reference');
        }
        expanded[key] = Object.fromEntries(Object.entries(value).map(([name, binding]) => [
          name,
          substitutePassThrough(binding, declarations, bindings, options, [...fieldPath, name]),
        ]));
        break;
      case 'parallel':
        if (!Array.isArray(value) && !isPlainObject(value)) {
          assertNoParamReferences(value, options, fieldPath);
          expanded[key] = value;
          break;
        }
        if (Array.isArray(value)) {
          expanded[key] = value.map((child, index) => (
            isPlainObject(child)
              ? bindStepFields(child, declarations, bindings, options, [...fieldPath, index])
              : (assertNoParamReferences(child, options, [...fieldPath, index]), child)
          ));
          break;
        }
        expanded[key] = Object.fromEntries(Object.entries(value).map(([branch, children]) => {
          const branchPath = [...fieldPath, branch];
          if (branch !== 'fixed' && branch !== 'pool') {
            assertNoParamReferences(children, options, branchPath);
            return [branch, children];
          }
          if (!Array.isArray(children)) {
            assertNoParamReferences(children, options, branchPath);
            return [branch, children];
          }
          return [branch, children.map((child, index) => (
            isPlainObject(child)
              ? bindStepFields(child, declarations, bindings, options, [...branchPath, index])
              : (assertNoParamReferences(child, options, [...branchPath, index]), child)
          ))];
        }));
        break;
      default:
        assertNoParamReferences(value, options, fieldPath);
        expanded[key] = value;
    }
  }
  BOUND_STEP_FRAGMENT_SOURCES.set(expanded, {
    path,
    sourcePath: options.fragmentPath,
  });
  return expanded;
}

export function getWorkflowParamDeclarations(raw: RawRecord): ReadonlyMap<string, FragmentParamDeclaration> {
  const subworkflow = getOwnValue(raw, 'subworkflow');
  const rawParams = isPlainObject(subworkflow) ? getOwnValue(subworkflow, 'params') : undefined;
  if (!isPlainObject(rawParams)) return new Map();
  const declarations = new Map<string, FragmentParamDeclaration>();
  for (const [name, value] of Object.entries(rawParams)) {
    if (!isPlainObject(value)) continue;
    const type = getOwnValue(value, 'type');
    const facetKind = getOwnValue(value, 'facet_kind');
    if ((type === 'workflow_ref' || type === 'facet_pool_ref') && facetKind === undefined) {
      declarations.set(name, { type });
      continue;
    }
    if (
      (type === 'facet_ref' || type === 'facet_ref[]')
      && typeof facetKind === 'string'
      && FACET_KINDS.has(facetKind as FragmentFacetKind)
    ) {
      declarations.set(name, {
        type,
        facetKind: facetKind as FragmentFacetKind,
      });
    }
  }
  return declarations;
}

export function bindStepFragmentParams(
  fragment: RawRecord,
  caller: RawRecord,
  options: BindStepFragmentParamsOptions,
): BoundStepFragment {
  const boundPaths: Array<readonly PropertyKey[]> = [];
  const internalOptions = { ...options, boundPaths };
  const declarations = parseFragmentDeclarations(fragment, internalOptions);
  const bindings = resolveBindings(caller, declarations, internalOptions);
  return {
    boundPaths,
    value: bindStepFields(fragment, declarations, bindings, internalOptions, []),
  };
}

export function getBoundStepFragmentSource(step: RawRecord): BoundStepFragmentSource | undefined {
  return BOUND_STEP_FRAGMENT_SOURCES.get(step);
}
