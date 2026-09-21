export function Editor({ save }: { save(): void }) {
  return (
    <form onSubmit={(event) => {
      event.preventDefault();
      save();
    }}>
      <button type="submit" onClick={() => save()}>
        Save
      </button>
    </form>
  );
}
