export function RecordRow({ id, label, onDelete }: {
  id: string; label: string; onDelete(id: string): void;
}) {
  return <li>{label}<button type="button" aria-label={`Delete ${label}`} onClick={() => onDelete(id)}>Delete</button></li>;
}
