function encodeWorkflowNamespaceValue(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function workflowCallNamespaceSegmentsMatch(left: string, right: string): boolean {
  return normalizeWorkflowCallNamespaceSegment(left) === normalizeWorkflowCallNamespaceSegment(right);
}

export function workflowCallNamespacePathsMatch(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((segment, index) => workflowCallNamespaceSegmentsMatch(segment, right[index]!));
}

function normalizeWorkflowCallNamespaceSegment(segment: string): string {
  return /^iteration-(?:\d+|\*)--step-[^/]+--workflow-[^/]+$/.test(segment)
    ? segment.replace(/^iteration-\d+--/, 'iteration-*--')
    : segment;
}

export function buildWorkflowCallNamespaceSegment(
  stepName: string,
  workflowName: string,
  iteration: number | '*',
): string {
  return `iteration-${iteration}--step-${encodeWorkflowNamespaceValue(stepName)}--workflow-${encodeWorkflowNamespaceValue(workflowName)}`;
}
