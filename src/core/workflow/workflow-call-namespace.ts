function encodeWorkflowNamespaceValue(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

const WORKFLOW_CALL_NAMESPACE_PATTERN = /^iteration-([1-9]\d*|\*)--step-([^/]+)--workflow-([^/]+?)(?:--site-([a-f0-9]{64}))?$/;

export interface WorkflowCallNamespace {
  readonly iteration: number | '*';
  readonly stepName: string;
  readonly workflowName: string;
  readonly siteDigest?: string;
}

export function parseWorkflowCallNamespaceSegment(
  segment: string,
): WorkflowCallNamespace | undefined {
  const match = WORKFLOW_CALL_NAMESPACE_PATTERN.exec(segment);
  if (match === null) {
    return undefined;
  }
  try {
    const iteration = match[1] === '*' ? '*' : Number(match[1]);
    const stepName = decodeURIComponent(match[2]!);
    const workflowName = decodeURIComponent(match[3]!);
    const siteDigest = match[4];
    if (stepName.length === 0 || workflowName.length === 0) {
      return undefined;
    }
    const canonicalSegment = [
      buildWorkflowCallNamespaceSegment(stepName, workflowName, iteration),
      ...(siteDigest === undefined ? [] : [`site-${siteDigest}`]),
    ].join('--');
    return canonicalSegment === segment
      ? { iteration, stepName, workflowName, ...(siteDigest === undefined ? {} : { siteDigest }) }
      : undefined;
  } catch {
    return undefined;
  }
}

export function workflowCallReportRequestSegmentsMatch(
  actual: string,
  requested: string,
): boolean {
  if (actual === requested) {
    return true;
  }
  if (
    parseWorkflowCallNamespaceSegment(requested)?.iteration !== '*'
    || parseWorkflowCallNamespaceSegment(actual) === undefined
  ) {
    return false;
  }
  return actual.replace(/^iteration-\d+--/, 'iteration-*--') === requested;
}

export function workflowCallReportRequestPathsMatch(
  actual: readonly string[],
  requested: readonly string[],
): boolean {
  return actual.length === requested.length
    && actual.every((segment, index) => workflowCallReportRequestSegmentsMatch(segment, requested[index]!));
}

export function workflowCallRunNamespaceSegmentsCorrespond(
  source: string,
  target: string,
): boolean {
  if (source === target) {
    return true;
  }
  if (
    parseWorkflowCallNamespaceSegment(source) === undefined
    || parseWorkflowCallNamespaceSegment(target) === undefined
  ) {
    return false;
  }
  return source.replace(/^iteration-\d+--/, 'iteration-*--')
    === target.replace(/^iteration-\d+--/, 'iteration-*--');
}

export function workflowCallRunNamespacePathsCorrespond(
  source: readonly string[],
  target: readonly string[],
): boolean {
  return source.length === target.length
    && source.every((segment, index) => workflowCallRunNamespaceSegmentsCorrespond(segment, target[index]!));
}

export function buildWorkflowCallNamespaceSegment(
  stepName: string,
  workflowName: string,
  iteration: number | '*',
): string {
  if (stepName.length === 0 || workflowName.length === 0) {
    throw new Error('Workflow-call namespace requires non-empty step and workflow names');
  }
  if (iteration !== '*' && (!Number.isInteger(iteration) || iteration < 1)) {
    throw new Error('Workflow-call namespace requires a positive iteration');
  }
  return `iteration-${iteration}--step-${encodeWorkflowNamespaceValue(stepName)}--workflow-${encodeWorkflowNamespaceValue(workflowName)}`;
}

export function workflowCallNamespaceSegmentMatchesInvocation(
  segment: string,
  stepName: string,
  workflowName: string,
): boolean {
  const parsed = parseWorkflowCallNamespaceSegment(segment);
  return parsed !== undefined
    && parsed.stepName === stepName
    && parsed.workflowName === workflowName;
}
