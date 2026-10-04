import assert from 'node:assert/strict';
import { test } from 'node:test';
import { measurePaginationAdapters } from './measure-pagination.mjs';
import { createRecordRepository as originalRepository } from '../fixtures/page-query-implementation/src/repository.mjs';
import assertPagination from './db-pagination-implement.mjs';

async function measureImplementation(historySource, repositorySource) {
  const { readHistoryPage } = await import(`data:text/javascript,${encodeURIComponent(historySource)}`);
  const createRecordRepository = repositorySource === undefined
    ? originalRepository
    : (await import(`data:text/javascript,${encodeURIComponent(repositorySource)}`)).createRecordRepository;
  const measurement = await measurePaginationAdapters(readHistoryPage, createRecordRepository);
  return { measurement, judgment: assertPagination(JSON.stringify({ measurement })) };
}

const boundedRepository = `export function createRecordRepository(database) {
  return {
    readRecords(tenantId) {
      return database.prepare('SELECT id, title FROM records WHERE tenant_id = ? ORDER BY id').all(tenantId);
    },
    readPage(tenantId, offset) {
      return database.prepare('SELECT id, title FROM records WHERE tenant_id = ? ORDER BY id LIMIT 21 OFFSET ?').all(tenantId, offset);
    },
  };
}`;
const boundedHistory = `export function readHistoryPage(repository, tenantId, offset) {
  const records = repository.readPage(tenantId, offset);
  return { items: records.slice(0, 20), hasMore: records.length > 20 };
}`;

test('assertion rejects all-record materialization even when every returned page is correct', async () => {
  const result = await measureImplementation(`export function readHistoryPage(repository, tenantId, offset) {
    const records = repository.readRecords(tenantId);
    return { items: records.slice(offset, offset + 20), hasMore: records.length > offset + 20 };
  }`);
  assert.equal(result.judgment.pass, false);
  assert.match(result.judgment.reason, /DB read exceeds fixture budget/);
  assert.doesNotMatch(result.judgment.reason, /page response|export behavior/);
  assert.ok(result.measurement.some((sample) => sample.fetchedRows === 2000));
});

test('assertion accepts bounded database pagination and keeps the full export separate', async () => {
  const result = await measureImplementation(boundedHistory, boundedRepository);
  assert.equal(result.judgment.pass, true, result.judgment.reason);
});

test('assertion rejects a fixed empty page even though its DB read count is zero', async () => {
  const result = await measureImplementation(`export function readHistoryPage() {
    return { items: [], hasMore: false };
  }`);
  assert.equal(result.judgment.pass, false);
  assert.match(result.judgment.reason, /page response/);
});

test('assertion rejects bounding the existing full-export contract', async () => {
  const result = await measureImplementation(boundedHistory,
    boundedRepository.replace('WHERE tenant_id = ? ORDER BY id\').all', 'WHERE tenant_id = ? ORDER BY id LIMIT 20\').all'));
  assert.equal(result.judgment.pass, false);
  assert.match(result.judgment.reason, /export behavior changed/);
});

test('measurement includes full-table loading during repository construction', async () => {
  const result = await measureImplementation(boundedHistory, `export function createRecordRepository(database) {
    const records = database.prepare('SELECT id, title, tenant_id FROM records ORDER BY id').all();
    return {
      readRecords(tenantId) { return records.filter((row) => row.tenant_id === tenantId); },
      readPage(tenantId, offset) { return records.filter((row) => row.tenant_id === tenantId).slice(offset, offset + 21); },
    };
  }`);
  assert.equal(result.judgment.pass, false);
  assert.match(result.judgment.reason, /DB read exceeds fixture budget/);
});

test('assertion rejects absent independent measurements', () => {
  assert.equal(assertPagination(JSON.stringify({ measurement: [] })).pass, false);
});

for (const items of [{}, [null], [42]]) {
  test(`assertion rejects malformed items ${JSON.stringify(items)} without throwing`, async () => {
    const result = await measureImplementation(`export function readHistoryPage() {
      return { items: ${JSON.stringify(items)}, hasMore: false };
    }`);
    assert.equal(result.judgment.pass, false);
    assert.match(result.judgment.reason, /page response/);
  });
}
