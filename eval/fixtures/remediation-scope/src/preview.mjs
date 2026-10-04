export async function preview(store, id) {
  const snapshot = await store.openSnapshot(id);
  return store.readSnapshot(snapshot);
}
