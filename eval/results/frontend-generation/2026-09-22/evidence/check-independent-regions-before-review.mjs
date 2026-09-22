import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const [url, adapterPath, outputDirectory] = process.argv.slice(2);
if (!url || !adapterPath || !outputDirectory) {
  throw new Error('Usage: node check-independent-regions.mjs URL ADAPTER_JSON OUTPUT_DIR');
}
const adapter = JSON.parse(await readFile(adapterPath, 'utf8'));
await mkdir(outputDirectory, { recursive: true });
const browser = await chromium.launch({ headless: true });
const results = [];
const field = (page, region, key) => page.locator(adapter.regions[region][key]);
const count = async (page, region) => Number((await field(page, region, 'count').innerText()).match(/\d+/)?.[0]);
async function notify(page, region, times = 1) {
  await field(page, region, 'draft').evaluate((element, repetitions) => {
    for (let i = 0; i < repetitions; i++) {
      element.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true,
      }));
    }
  }, times);
}
async function sent(page, region, text) {
  await field(page, region, 'result').filter({ hasText: text }).waitFor();
}
async function check(name, run) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(url);
    await run(page);
    assert.deepEqual(errors, []);
    results.push({ name, status: 'PASS' });
  } catch (error) {
    results.push({ name, status: 'FAIL', error: error.message });
    await page.screenshot({ path: `${outputDirectory}/failure-${results.length}.png`, fullPage: true });
  } finally {
    await page.close();
    console.log(results.at(-1));
  }
}

await check('二領域の入力と送信結果が混ざらない', async page => {
  await field(page, 0, 'draft').fill('第一の本文');
  await field(page, 1, 'draft').fill('第二の本文');
  await field(page, 0, 'send').click();
  await sent(page, 0, '第一の本文');
  assert.equal(await field(page, 1, 'draft').inputValue(), '第二の本文');
  assert.equal(await count(page, 0), 1);
  assert.equal(await count(page, 1), 0);
  await field(page, 1, 'send').click();
  await sent(page, 1, '第二の本文');
  assert.equal(await count(page, 1), 1);
});

await check('一方の処理中も他方を編集して送信できる', async page => {
  await field(page, 0, 'draft').fill('先に開始');
  await notify(page, 0);
  assert.equal(await count(page, 0), 1);
  assert.equal(await field(page, 0, 'draft').isEditable(), false);
  await field(page, 1, 'draft').fill('独立した送信');
  await notify(page, 1);
  assert.equal(await count(page, 1), 1);
  await sent(page, 0, '先に開始');
  await sent(page, 1, '独立した送信');
});

await check('同一タスク内の連続通知を一回だけ受理する', async page => {
  await field(page, 0, 'draft').fill('一回の本文');
  await notify(page, 0, 3);
  assert.equal(await count(page, 0), 1);
  await notify(page, 0);
  await sent(page, 0, '一回の本文');
  assert.equal(await count(page, 0), 1);
});

await check('通常Enterは改行し、CtrlとCommandで送信する', async page => {
  for (const [region, modifier] of [[0, 'Control'], [1, 'Meta']]) {
    await field(page, region, 'draft').fill('一行目');
    await field(page, region, 'draft').press('End');
    await field(page, region, 'draft').press('Enter');
    await field(page, region, 'draft').pressSequentially('二行目');
    assert.equal(await field(page, region, 'draft').inputValue(), '一行目\n二行目');
    assert.equal(await count(page, region), 0);
    await field(page, region, 'draft').press(`${modifier}+Enter`);
    await sent(page, region, '一行目');
    assert.equal(await count(page, region), 1);
  }
});

await check('空白だけの入力を両入口から拒否し、修正後に送信できる', async page => {
  await field(page, 0, 'draft').fill(' \n ');
  await field(page, 0, 'send').click();
  await notify(page, 0);
  assert.equal(await count(page, 0), 0);
  assert.match(await field(page, 0, 'status').innerText(), new RegExp(adapter.emptyText));
  await field(page, 0, 'draft').fill('修正した本文');
  await notify(page, 0);
  await sent(page, 0, '修正した本文');
});

await check('確認中の領域は保存通知を拒否し、取消後は同じ入口から送信できる', async page => {
  // Confirm the notification path works before testing its rejection.
  await field(page, 0, 'draft').fill('入口の確認');
  await notify(page, 0);
  await sent(page, 0, '入口の確認');
  await field(page, 0, 'draft').fill('残す本文');
  await field(page, 0, 'clear').click();
  assert.equal(await field(page, 0, 'draft').isEditable(), false);
  await notify(page, 0);
  assert.equal(await count(page, 0), 1);
  assert.equal(await field(page, 0, 'draft').inputValue(), '残す本文');
  await field(page, 0, 'cancel').click();
  assert.equal(await field(page, 0, 'draft').inputValue(), '残す本文');
  await notify(page, 0);
  await sent(page, 0, '残す本文');
  assert.equal(await count(page, 0), 2);
});

await check('一方の破棄確認中も他方を送信でき、確認した側だけ破棄する', async page => {
  await field(page, 0, 'draft').fill('破棄する本文');
  await field(page, 0, 'clear').click();
  await field(page, 1, 'draft').fill('継続する本文');
  await field(page, 1, 'send').click();
  await sent(page, 1, '継続する本文');
  await field(page, 0, 'discard').click();
  assert.equal(await field(page, 0, 'draft').inputValue(), '');
  assert.equal(await count(page, 0), 0);
  assert.equal(await count(page, 1), 1);
});

await check('失敗は宛先ごとに一度だけ起こり、本文を保持して再試行できる', async page => {
  await field(page, 0, 'draft').fill('再試行する本文');
  await field(page, 0, 'failure').click();
  await field(page, 0, 'send').click();
  await field(page, 0, 'status').filter({ hasText: new RegExp(adapter.failureText) }).waitFor();
  assert.equal(await field(page, 0, 'draft').inputValue(), '再試行する本文');
  assert.equal(await count(page, 0), 1);
  await field(page, 1, 'draft').fill('失敗しない本文');
  await field(page, 1, 'send').click();
  await sent(page, 1, '失敗しない本文');
  await notify(page, 0);
  await sent(page, 0, '再試行する本文');
  assert.equal(await count(page, 0), 2);
});

await check('三つのヘルプ入口が同じ説明を開き、背景へ移動せず元へ戻る', async page => {
  const triggers = page.locator(adapter.help);
  assert.equal(await triggers.count(), 3);
  let content;
  for (let i = 0; i < 3; i++) {
    await triggers.nth(i).click();
    const dialog = page.getByRole('dialog');
    assert.equal(await dialog.count(), 1);
    const current = await dialog.innerText();
    if (i === 0) content = current;
    else assert.equal(current, content);
    for (const key of ['Tab', 'Shift+Tab']) {
      for (let j = 0; j < 12; j++) {
        await page.keyboard.press(key);
        assert.ok(await page.evaluate(() => document.activeElement?.tagName === 'BODY'
          || !!document.activeElement?.closest('dialog[open],[role="dialog"],[role="alertdialog"]')));
      }
    }
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    assert.ok(await triggers.nth(i).evaluate(element => element === document.activeElement));
  }
});

await browser.close();
const report = {
  url, adapter, results,
  passed: results.filter(result => result.status === 'PASS').length,
  failed: results.filter(result => result.status === 'FAIL').length,
};
await writeFile(`${outputDirectory}/results.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ passed: report.passed, failed: report.failed }));
process.exitCode = report.failed ? 1 : 0;
