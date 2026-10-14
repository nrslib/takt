import { parseCsvLine } from './csv-line.mjs';

export function parseAmount(text) {
  const trimmed = text.trim();
  if (!/^(\d{1,3}(,\d{3})+|\d+)$/.test(trimmed)) {
    throw new Error(`金額の形式が不正です: ${text}`);
  }
  return Number(trimmed.replace(/,/g, ''));
}

export function importVendorCsv(content) {
  const lines = content.split(/\r?\n/);
  const records = [];
  const errors = [];
  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    if (index === 0 || line.trim() === '') return;
    const fields = parseCsvLine(line);
    if (fields.length !== 4) {
      errors.push({ lineNumber, reason: `列の数が不正です: ${fields.length}` });
      return;
    }
    const [vendorCode, issuedOn, amountText, memo] = fields;
    try {
      records.push({ vendorCode, issuedOn, amount: parseAmount(amountText), memo });
    } catch (error) {
      errors.push({ lineNumber, reason: error.message });
    }
  });
  return { records, errors };
}
