import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleAdminRequest, submitInvoiceForm } from '../src/admin.mjs';
import { readInvoices } from '../src/store.mjs';

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'invoices-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, 'invoices.json');
}

test('変更前からの管理画面で円単位の明細を登録して保存する', async t => {
  const file = await setup(t);
  const invoice = await submitInvoiceForm(file, {
    customer: '顧客A', date: '2026-09-01', amount: '100',
  });
  assert.equal(invoice.amount, 100);
  assert.deepEqual(await readInvoices(file), [invoice]);
});

test('変更前から同じ顧客・日付・金額の重複登録を拒否する', async t => {
  const file = await setup(t);
  const fields = { customer: '顧客A', date: '2026-09-01', amount: '100' };
  const invoice = await submitInvoiceForm(file, fields);
  await assert.rejects(submitInvoiceForm(file, fields));
  assert.deepEqual(await readInvoices(file), [invoice]);
});

test('同じ顧客と日付で金額が異なる明細を管理画面の一覧で見分ける', async t => {
  const file = await setup(t);
  for (const amount of ['100', '200']) {
    await handleAdminRequest(file, 'POST', '/invoices', {
      customer: '顧客A', date: '2026-09-01', amount,
    });
  }
  const before = await readInvoices(file);
  const html = await handleAdminRequest(file, 'GET', '/', {});
  assert.ok(html.includes('<li>顧客A | 2026-09-01 | 100円</li>'));
  assert.ok(html.includes('<li>顧客A | 2026-09-01 | 200円</li>'));
  assert.ok(html.indexOf('100円') < html.indexOf('200円'));
  assert.deepEqual(await readInvoices(file), before);
  assert.equal(await handleAdminRequest(file, 'GET', '/summary', {}), '<p>300円</p>');
});

test('顧客または日付が異なる明細と空の一覧を表示する', async t => {
  const file = await setup(t);
  assert.ok((await handleAdminRequest(file, 'GET', '/', {})).includes('<ul></ul>'));
  for (const fields of [
    { customer: '顧客A', date: '2026-09-01', amount: '100' },
    { customer: '顧客B', date: '2026-09-01', amount: '100' },
    { customer: '顧客A', date: '2026-09-02', amount: '100' },
  ]) await submitInvoiceForm(file, fields);
  const html = await handleAdminRequest(file, 'GET', '/', {});
  assert.equal((html.match(/<li>/g) || []).length, 3);
  assert.ok(html.includes('顧客B | 2026-09-01 | 100円'));
  assert.ok(html.includes('顧客A | 2026-09-02 | 100円'));
});

test('管理画面の文字入力検証と HTML 表示を維持する', async t => {
  const file = await setup(t);
  await assert.rejects(submitInvoiceForm(file, {
    customer: '顧客A', date: '2026-09-01', amount: 'abc',
  }));
  await submitInvoiceForm(file, {
    customer: '顧客<追加>', date: '2026-09-01', amount: '100',
  });
  const html = await handleAdminRequest(file, 'GET', '/', {});
  assert.ok(html.includes('顧客&lt;追加&gt;'));
  assert.equal((await readInvoices(file))[0].customer, '顧客<追加>');
});
