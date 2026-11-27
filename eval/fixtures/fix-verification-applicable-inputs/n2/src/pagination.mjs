/** @param {number} page @param {number} totalPages */
export function clampPage(page, totalPages) {
  return Math.min(page, totalPages);
}

export function listPage(items, page, pageSize) {
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const selectedPage = clampPage(page, totalPages);
  const offset = (selectedPage - 1) * pageSize;
  return { page: selectedPage, items: items.slice(offset, offset + pageSize) };
}
