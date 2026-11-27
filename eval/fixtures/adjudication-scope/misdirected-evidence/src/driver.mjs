export async function query(store, options) {
  const rows = await store.scan();
  return { rows: rows.slice(options.offset, options.offset + options.limit) };
}
