import { useEffect, useRef, useState, type RefObject } from 'react';

function SaveModal({
  open,
  returnFocusRef,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
  onConfirm(): void;
  onCancel(): void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) {
      cancelRef.current?.focus();
      return;
    }
    returnFocusRef.current?.focus();
  }, [open, returnFocusRef]);

  if (!open) return null;

  return (
    <div className="backdrop">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="save-modal-title"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          }
        }}
      >
        <h2 id="save-modal-title">Save changes?</h2>
        <p>Confirm this save request.</p>
        <button ref={cancelRef} type="button" onClick={onCancel}>Cancel</button>
        <button type="button" onClick={onConfirm}>Confirm save</button>
      </div>
    </div>
  );
}

export function App() {
  const [confirming, setConfirming] = useState(false);
  const [acceptedRequests, setAcceptedRequests] = useState(0);
  const [saved, setSaved] = useState(0);
  const [backgroundActions, setBackgroundActions] = useState(0);
  const [notice, setNotice] = useState('Ready');
  const triggerRef = useRef<HTMLButtonElement>(null);

  function requestSave() {
    if (confirming) {
      setNotice('Save request rejected while confirmation is open');
      return;
    }
    setAcceptedRequests((count) => count + 1);
    setConfirming(true);
    setNotice('Confirmation pending');
  }

  function confirmSave() {
    setConfirming(false);
    setSaved((count) => count + 1);
    setNotice('Saved');
  }

  return (
    <main>
      <h1>Draft editor</h1>
      <p role="status">{notice}</p>
      <output aria-label="Accepted save requests">{acceptedRequests}</output>
      <output aria-label="Saved operations">{saved}</output>
      <output aria-label="Background actions">{backgroundActions}</output>
      <button ref={triggerRef} type="button" onClick={requestSave}>Open save confirmation</button>
      <button type="button" onClick={() => setBackgroundActions((count) => count + 1)}>
        Background action
      </button>
      <SaveModal
        open={confirming}
        returnFocusRef={triggerRef}
        onCancel={() => setConfirming(false)}
        onConfirm={confirmSave}
      />
    </main>
  );
}
