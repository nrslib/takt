import { useEffect, useRef, useState } from 'react';

function DiscardConfirmation({
  open,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  onConfirm(): void;
  onCancel(): void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog ref={dialogRef} aria-labelledby="discard-confirmation-title" onCancel={onCancel}>
      <h2 id="discard-confirmation-title">Discard draft?</h2>
      <p>Unfinished edits will be discarded.</p>
      <button type="button" onClick={onCancel}>Keep editing</button>
      <button type="button" onClick={onConfirm}>Discard draft</button>
    </dialog>
  );
}

function Screen({ savedDraft, saveCount, onSave }: {
  savedDraft: string;
  saveCount: number;
  onSave(value: string): void;
}) {
  const [draft, setDraft] = useState('Initial');
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState('Ready');

  function requestSave() {
    if (confirming) {
      setNotice('Save request rejected while discard confirmation is open');
      return;
    }
    onSave(draft);
    setNotice('Saved');
  }

  function confirmDiscard() {
    setDraft(savedDraft);
    setConfirming(false);
    setNotice('Draft discarded');
  }

  return (
    <main>
      <h1>Draft editor</h1>
      <p role="status">{notice}</p>
      <label>
        Draft
        <input aria-label="Draft" value={draft} onChange={(event) => setDraft(event.target.value)} />
      </label>
      <output aria-label="Saved content">{savedDraft}</output>
      <output aria-label="Save count">{saveCount}</output>
      <button type="button" onClick={() => setConfirming(true)}>Open discard confirmation</button>
      <button type="button" onClick={requestSave}>Save draft</button>
      <DiscardConfirmation
        open={confirming}
        onCancel={() => setConfirming(false)}
        onConfirm={confirmDiscard}
      />
    </main>
  );
}

export function App() {
  const [savedDraft, setSavedDraft] = useState('Initial');
  const [saveCount, setSaveCount] = useState(0);

  function save(value: string) {
    setSavedDraft(value);
    setSaveCount((count) => count + 1);
  }

  return (
    <Screen savedDraft={savedDraft} saveCount={saveCount} onSave={save} />
  );
}
