export function Editor({ save, recordClick }: { save(): void; recordClick(): void }) {
  return <section onClick={recordClick}>
    <form onSubmit={(event) => { event.preventDefault(); save(); }}>
      <button type="submit" onClick={save}>Save</button>
    </form>
  </section>;
}
