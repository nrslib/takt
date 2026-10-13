const unitsPerCase = new Map([
  ['TOKYO', 12],
  ['OSAKA', 24],
  ['FUKUOKA', 6],
]);

function stockUnits(record) {
  if (!unitsPerCase.has(record.warehouse)) throw new Error(`Unknown warehouse: ${record.warehouse}`);
  if (record.warehouse === 'TOKYO' || record.warehouse === 'OSAKA') {
    return record.cases * unitsPerCase.get(record.warehouse) + record.looseUnits;
  }
  return record.cases + record.looseUnits;
}

export function syncInventory(records) {
  return records.map((record) => ({
    warehouse: record.warehouse,
    sku: record.sku,
    quantity: stockUnits(record),
  }));
}
