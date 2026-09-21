export function RecordRow({ id, label, remove }: {
  id: string; label: string; remove(workspace: string, id: string): void;
}) {
  function handleDelete() {
    const workspace = window.location.pathname.split('/')[2];
    remove(workspace, id);
    window.location.assign(`/workspaces/${workspace}/records`);
  }
  return <li>{label}<button type="button" onClick={handleDelete}>Delete</button></li>;
}
