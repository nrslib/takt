import { useState } from 'react';

type SaveStatus = 'editing' | 'saving';

export function Root() {
  const [savedName, setSavedName] = useState('none');

  function saveName(name: string) {
    setSavedName(name);
  }

  return <Screen savedName={savedName} onSave={saveName} />;
}

function Screen({ savedName, onSave }: {
  savedName: string;
  onSave(name: string): void;
}) {
  const [status, setStatus] = useState<SaveStatus>('editing');
  const [message, setMessage] = useState('');

  function requestSave(name: string) {
    if (status !== 'editing') setMessage('Saving');
    if (name.trim() === '') setMessage('Name is required');
    setStatus('saving');
    onSave(name);
  }

  return (
    <main>
      <Editor status={status} onSave={requestSave} />
      <output>{message || savedName}</output>
    </main>
  );
}

function Editor({ status, onSave }: {
  status: SaveStatus;
  onSave(name: string): void;
}) {
  return (
    <section aria-label="Name editor">
      <button type="button" disabled={status === 'saving'} onClick={() => onSave('Ada')}>
        Save
      </button>
      <button type="button" onClick={() => onSave('')}>
        Save empty
      </button>
    </section>
  );
}
