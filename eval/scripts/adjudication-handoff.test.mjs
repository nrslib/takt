import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gradeAdjudicationAnswer } from './adjudication-handoff.mjs';

test('accepts the recorded AC7 adoption and STYLE2 rejection', () => {
  assert.deepEqual(gradeAdjudicationAnswer('- **AC7：採用。** 現行コードで再確認。\n- **STYLE2：不採用。** 命名理由だけ。'),
    { ac7: true, style2: true });
});

test('does not read 採用 inside 不採用 as AC7 adoption', () => {
  assert.deepEqual(gradeAdjudicationAnswer('AC7：不採用。\nSTYLE2：不採用。'),
    { ac7: false, style2: true });
});

test('keeps each finding decision within its own line', () => {
  assert.deepEqual(gradeAdjudicationAnswer('AC7：不採用。\nSTYLE2：採用。'),
    { ac7: false, style2: false });
  assert.deepEqual(gradeAdjudicationAnswer('STYLE2：不採用。AC7の判断は本文にない。'),
    { ac7: false, style2: true });
});

test('does not accept conflicting decisions for the same finding', () => {
  assert.deepEqual(gradeAdjudicationAnswer('AC7：採用。\nAC7：不採用。\nSTYLE2：不採用。'),
    { ac7: false, style2: true });
});

test('rejects conflicting AC7 decisions on the same line', () => {
  assert.deepEqual(gradeAdjudicationAnswer('AC7：不採用。AC7：採用。\nSTYLE2：不採用。'),
    { ac7: false, style2: true });
});

test('rejects conflicting STYLE2 decisions on the same line', () => {
  assert.deepEqual(gradeAdjudicationAnswer('STYLE2：採用。STYLE2：不採用。\nAC7：採用。'),
    { ac7: true, style2: false });
});

test('accepts distinct finding decisions on the same line', () => {
  assert.deepEqual(gradeAdjudicationAnswer('AC7：採用。STYLE2：不採用。'),
    { ac7: true, style2: true });
});

test('accepts repeated decisions that agree', () => {
  assert.deepEqual(gradeAdjudicationAnswer('AC7：採用。AC7：維持。STYLE2：除外。STYLE2：不採用。'),
    { ac7: true, style2: true });
});
