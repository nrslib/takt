export async function publish(store, content) {
  const staged = await store.stage(content);
  const result = await store.publish(staged);
  await store.discard(staged);
  return result;
}
