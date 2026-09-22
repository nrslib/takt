import { useState } from 'react';

type SaveStatus = 'editing' | 'saving';

export function Root() {
  const [savedName, setSavedName] = useState('none');
  const [status, setStatus] = useState<SaveStatus>('editing');

  async function saveName(name: string) {
    setStatus('saving');
    await new Promise<void>((resolve) => window.setTimeout(resolve, 40));
    setSavedName(name);
    setStatus('editing');
  }

  return <Screen savedName={savedName} status={status} onSave={saveName} />;
}

function Screen({ savedName, status, onSave }: {
  savedName: string;
  status: SaveStatus;
  onSave(name: string): Promise<void>;
}) {
  const [message, setMessage] = useState('');

  async function requestSave(name: string) {
    if (status !== 'editing') {
      setMessage('Saving');
    }
    if (name.trim() === '') {
      setMessage('Name is required');
    }
    setMessage('');
    await onSave(name);
    setMessage('');
  }

  return (
    <main>
      <Editor status={status} onSave={requestSave} />
      <output aria-label="Save status">{status}</output>
      <output aria-label="Save feedback">{message}</output>
      <output aria-label="Saved name">{savedName}</output>
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
