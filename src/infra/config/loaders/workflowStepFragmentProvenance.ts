import { getOwnValue, isPlainObject, type RawRecord } from './workflowStepFragmentReader.js';

export interface WorkflowStepFragmentProvenance {
  stepPath: readonly PropertyKey[];
  ref: string;
  sourcePath: string;
}

interface OverriddenProvenancePaths {
  exact: readonly (readonly PropertyKey[])[];
  descendants: readonly (readonly PropertyKey[])[];
}

export function isPathWithin(path: readonly PropertyKey[], parentPath: readonly PropertyKey[]): boolean {
  return parentPath.every((part, index) => path[index] === part);
}

function pathsMatch(left: readonly PropertyKey[], right: readonly PropertyKey[]): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

export function findFragmentProvenanceAtExactPath(
  provenance: readonly WorkflowStepFragmentProvenance[],
  sourcePath: readonly PropertyKey[],
): WorkflowStepFragmentProvenance | undefined {
  return provenance.find((entry) => pathsMatch(entry.stepPath, sourcePath));
}

export function findFragmentProvenanceForStep(
  provenance: readonly WorkflowStepFragmentProvenance[],
  sourcePath: readonly PropertyKey[],
): WorkflowStepFragmentProvenance | undefined {
  for (let index = sourcePath.length; index >= 2; index -= 1) {
    const candidate = sourcePath.slice(0, index);
    const source = findFragmentProvenanceAtExactPath(provenance, candidate);
    if (source !== undefined) {
      return source;
    }
  }
  return undefined;
}

function collectOverriddenPaths(base: RawRecord, override: RawRecord, stepPath: readonly PropertyKey[]): OverriddenProvenancePaths {
  const exact: Array<readonly PropertyKey[]> = [];
  const descendants: Array<readonly PropertyKey[]> = [];
  for (const [key, overrideValue] of Object.entries(override)) {
    const baseValue = getOwnValue(base, key);
    const overriddenPath = [...stepPath, key];
    if (isPlainObject(baseValue) && isPlainObject(overrideValue)) {
      exact.push(overriddenPath);
      const nested = collectOverriddenPaths(baseValue, overrideValue, overriddenPath);
      exact.push(...nested.exact);
      descendants.push(...nested.descendants);
      continue;
    }
    descendants.push(overriddenPath);
  }
  return { exact, descendants };
}

export function withoutOverriddenProvenance(
  provenance: readonly WorkflowStepFragmentProvenance[],
  base: RawRecord,
  override: RawRecord,
  stepPath: readonly PropertyKey[],
): WorkflowStepFragmentProvenance[] {
  const paths = collectOverriddenPaths(base, override, stepPath);
  return provenance
    .filter((entry) => !paths.exact.some((path) => pathsMatch(entry.stepPath, path)))
    .filter((entry) => !paths.descendants.some((path) => isPathWithin(entry.stepPath, path)));
}

export function collectFragmentProvenance(
  fragment: unknown,
  ref: string,
  sourcePath: string,
  stepPath: readonly PropertyKey[],
): WorkflowStepFragmentProvenance[] {
  if (Array.isArray(fragment)) {
    return [
      { stepPath, ref, sourcePath },
      ...fragment.flatMap((item, index) => {
        const propertyPath = [...stepPath, index];
        return isPlainObject(item) || Array.isArray(item)
          ? collectFragmentProvenance(item, ref, sourcePath, propertyPath)
          : [{ stepPath: propertyPath, ref, sourcePath }];
      }),
    ];
  }
  if (!isPlainObject(fragment)) return [];
  const provenance = [{ stepPath, ref, sourcePath }];
  for (const key of Object.keys(fragment)) {
    if (key === 'uses') continue;
    const propertyPath = [...stepPath, key];
    const value = getOwnValue(fragment, key);
    provenance.push(...(isPlainObject(value) || Array.isArray(value)
      ? collectFragmentProvenance(value, ref, sourcePath, propertyPath)
      : [{ stepPath: propertyPath, ref, sourcePath }]));
  }
  return provenance;
}
