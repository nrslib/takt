function denied(reason) {
  return { isError: true, content: [{ type: 'text', text: reason }] };
}

export function executeTool(request, session) {
  if (session.readOnly) return denied('This session does not permit project changes.');
  if (request.action !== 'publish') return denied('This operation is not supported.');
  if (request.projectPath.startsWith('/') || request.projectPath.split('/').includes('..')) {
    return denied('The requested path is outside the permitted project.');
  }
  return { isError: false, content: [{ type: 'text', text: `Published ${request.projectPath}.` }] };
}
