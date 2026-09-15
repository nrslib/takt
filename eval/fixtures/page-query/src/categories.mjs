const categories = ['draft', 'submitted', 'approved', 'archived', 'cancelled', 'failed'];

export function readCategoryPage(offset) {
  return {
    items: categories.slice(offset, offset + 20),
    hasMore: categories.length > offset + 20,
  };
}
