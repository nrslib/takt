import { useState } from 'react';

type RecordAction =
  | { type: 'select'; id: string }
  | { type: 'remove'; id: string };

export function Root() {
  const [records, setRecords] = useState<readonly string[]>(['one', 'two']);

  function handleAction(action: RecordAction) {
    if (action.type === 'remove') {
      setRecords((current) => current.filter((id) => id !== action.id));
    }
  }

  return <Screen records={records} onAction={handleAction} />;
}

function Screen({ records, onAction }: {
  records: readonly string[];
  onAction(action: RecordAction): void;
}) {
  const [selectedId, setSelectedId] = useState('one');

  function handleAction(action: RecordAction) {
    if (action.type === 'select') {
      setSelectedId(action.id);
      return;
    }
    onAction(action);
  }

  return (
    <main>
      <RecordActions records={records} selectedId={selectedId} onAction={handleAction} />
      <output>Selected: {selectedId}</output>
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
