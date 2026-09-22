import { useState } from 'react';

type RecordAction =
  | { type: 'select'; id: string }
  | { type: 'remove'; id: string };

export function Root() {
  const [records, setRecords] = useState<readonly string[]>(['one', 'two']);
  const [rootSelectedId, setRootSelectedId] = useState('one');

  function handleAction(action: RecordAction) {
    if (action.type === 'select') setRootSelectedId(action.id);
    if (action.type === 'remove') {
      setRecords((current) => current.filter((id) => id !== action.id));
    }
  }

  return <Screen records={records} rootSelectedId={rootSelectedId} onAction={handleAction} />;
}

function Screen({ records, rootSelectedId, onAction }: {
  records: readonly string[];
  rootSelectedId: string;
  onAction(action: RecordAction): void;
}) {
  const [selectedId, setSelectedId] = useState('one');

  function handleAction(action: RecordAction) {
    if (action.type === 'select') setSelectedId(action.id);
    onAction(action);
  }

  return (
    <main>
      <RecordActions records={records} selectedId={selectedId} onAction={handleAction} />
      <output>Screen: {selectedId}; Root: {rootSelectedId}</output>
    </main>
  );
}

function RecordActions({ records, selectedId, onAction }: {
  records: readonly string[];
  selectedId: string;
  onAction(action: RecordAction): void;
}) {
  return (
    <section aria-label="Record actions">
      <output>{records.join(', ')}</output>
      <button type="button" onClick={() => onAction({ type: 'select', id: 'two' })}>
        Select two
      </button>
      <button type="button" onClick={() => onAction({ type: 'remove', id: selectedId })}>
        Remove
      </button>
    </section>
  );
}
