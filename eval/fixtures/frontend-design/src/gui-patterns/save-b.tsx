type Status = 'editing' | 'saving' | 'saved';
export function Editor({ status, save }: { status: Status; save(): void }) {
  function requestSave() {
    if (status === 'editing') save();
  }
  return <section onKeyDown={(event) => {
    if (event.ctrlKey && event.key === 's') { event.preventDefault(); requestSave(); }
  }}>
    <button type="button" disabled={status !== 'editing'} onClick={requestSave}>Save</button>
    <input aria-label="Title" />
  </section>;
}
