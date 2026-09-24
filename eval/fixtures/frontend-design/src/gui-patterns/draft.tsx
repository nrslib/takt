import { useState } from 'react';
export function NameDialog({ initialName, onConfirm }: {
  initialName: string; onConfirm(name: string): void;
}) {
  const [draft, setDraft] = useState(initialName);
  return <form onSubmit={(event) => { event.preventDefault(); onConfirm(draft); }}>
    <input aria-label="Name" value={draft} onChange={(event) => setDraft(event.target.value)} />
    <button type="submit">Confirm</button>
  </form>;
}
