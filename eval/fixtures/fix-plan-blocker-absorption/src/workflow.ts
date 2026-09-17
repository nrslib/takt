export function attachWorkflowOpaqueRef(workflow: { name: string }): { name: string; opaqueRef: string } {
  return { ...workflow, opaqueRef: `workflow:${workflow.name}` };
}
