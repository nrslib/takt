import type { Workspace } from '../../infra/config/global/workspaceRegistry.js';
import { sliceUtf8 } from '../../shared/utils/utf8.js';
import { jsonResult, MCP_TEXT_PAGE_BYTES } from './response.js';
import type { ListTasksInput } from './schemas.js';

export function workspaceResult(
  workspace: Workspace | undefined,
  input: Pick<ListTasksInput, 'limit' | 'offset' | 'path' | 'textOffset' | 'maxBytes'>,
) {
  if (workspace === undefined) return jsonResult({ workspace });
  if (input.path !== undefined) {
    const value = input.path === 'name' ? workspace.name
      : workspace.repositoryDirectories[Number(input.path.split('.')[1])];
    if (value === undefined) throw new Error('Selected workspace field does not exist');
    return jsonResult({ workspaceId: workspace.id, path: input.path,
      ...sliceUtf8(value, input.textOffset ?? 0, input.maxBytes ?? MCP_TEXT_PAGE_BYTES) });
  }
  const offset = input.offset ?? 0;
  const repositoryDirectories = workspace.repositoryDirectories.slice(offset, offset + (input.limit ?? 50));
  const totalCount = workspace.repositoryDirectories.length;
  const returnedCount = repositoryDirectories.length;
  return jsonResult({ workspace: {
    id: workspace.id, name: workspace.name, repositoryDirectories,
    collection: 'repositoryDirectories', totalCount, returnedCount, omittedCount: totalCount - returnedCount,
    offset, nextOffset: offset + returnedCount < totalCount ? offset + returnedCount : null,
    truncated: returnedCount < totalCount,
  } });
}
