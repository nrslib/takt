const TELEMETRY_PATTERN = /<scope-eval>\s*([\s\S]*?)\s*<\/scope-eval>/i;

function normalizePath(path) {
  return typeof path === 'string'
    ? path.replaceAll('`', '').replace(/^\.\//, '')
    : '';
}

function includesPath(paths, suffix) {
  return Array.isArray(paths) && paths.some((path) => normalizePath(path).endsWith(suffix));
}

export function parseScopeTelemetry(output) {
  const matches = [...output.matchAll(new RegExp(TELEMETRY_PATTERN.source, 'gi'))];
  if (matches.length !== 1) return null;

  try {
    const telemetry = JSON.parse(matches[0][1]);
    return telemetry && typeof telemetry === 'object' ? telemetry : null;
  } catch {
    return null;
  }
}

export function hasSharedBoundaryFamily(telemetry) {
  if (!Array.isArray(telemetry?.boundaryFamilies)) return false;

  return telemetry.boundaryFamilies.some((family) =>
    includesPath(family?.members, 'src/report-path.ts') &&
    includesPath(family?.members, 'src/attachment-path.ts') &&
    family?.sameObservedFailure === true &&
    family?.sharedOwnerCandidate === true &&
    includesPath(family?.behaviorEvidence, 'test/attachment-path.test.ts'),
  );
}

export default function assertArchitectureSearch(output) {
  const telemetry = parseScopeTelemetry(output);
  const checks = {
    'structured-telemetry': telemetry !== null,
    'shared-boundary-family': hasSharedBoundaryFamily(telemetry),
    'changed-path-finding': includesPath(telemetry?.findingPaths, 'src/report-path.ts'),
    'same-family-finding': includesPath(telemetry?.findingPaths, 'src/attachment-path.ts'),
    'no-unrelated-finding': !includesPath(telemetry?.findingPaths, 'src/legacy-counter.ts'),
    'no-structure-proxy': telemetry?.structureProxyFindings === false,
  };
  const failed = Object.entries(checks).filter(([, pass]) => !pass).map(([name]) => name);
  return {
    pass: failed.length === 0,
    score: (Object.keys(checks).length - failed.length) / Object.keys(checks).length,
    reason: failed.length === 0
      ? 'Required semantic search completed without unrelated findings.'
      : `Failed checks: ${failed.join(', ')}`,
  };
}
