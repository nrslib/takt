type Status = 'editing' | 'saving' | 'saved';
export function Editor({ status, save }: { status: Status; save(): void }) {
  return <section onKeyDown={(event) => {
    if (event.ctrlKey && event.key === 's') { event.preventDefault(); save(); }
  }}>
    <button type="button" disabled={status !== 'editing'} onClick={() => {
      if (status === 'editing') save();
    }}>Save</button>
    <input aria-label="Title" />
  </section>;
}
