#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const fixtureRoot = join(repoRoot, 'eval/fixtures/frontend-design/src/gui-patterns');
const SAVE_DELAY_MS = 40;

const CASES = [
  { file: 'guard-a.tsx', kind: 'guard', emptySaveAccepted: true, busyEmptySaveAccepted: true, savedAfterBusy: '' },
  { file: 'guard-b.tsx', kind: 'guard', emptySaveAccepted: false, busyEmptySaveAccepted: false, savedAfterBusy: 'Ada' },
  { file: 'confirmation-a.tsx', kind: 'confirmation', saveCount: 2, savedContent: 'Changed' },
  { file: 'confirmation-b.tsx', kind: 'confirmation', saveCount: 1, savedContent: 'Edited' },
  { file: 'modal-a.tsx', kind: 'modal', acceptedRequests: 1, backgroundBlocked: false, backgroundActions: 2 },
  { file: 'modal-b.tsx', kind: 'modal', acceptedRequests: 1, backgroundBlocked: true, backgroundActions: 1 },
];

function readOption(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function parseOptions(args) {
  if (args.includes('--help')) {
    console.log('Usage: node eval/scripts/frontend-gui-browser.mjs --project-dir <path>');
    console.log('   or: node eval/scripts/frontend-gui-browser.mjs --dependency-dir <path>');
    process.exit(0);
  }

  const projectDir = readOption(args, '--project-dir');
  const dependencyDir = readOption(args, '--dependency-dir')
    ?? (projectDir === undefined ? undefined : join(resolve(projectDir), 'node_modules'));
  if (dependencyDir === undefined) {
    throw new Error('Pass --project-dir or --dependency-dir so the temporary app can resolve ReactDOM');
  }

  const resolvedDependencyDir = resolve(dependencyDir);
  if (!existsSync(resolvedDependencyDir) || !lstatSync(resolvedDependencyDir).isDirectory()) {
    throw new Error(`Dependency directory does not exist: ${resolvedDependencyDir}`);
  }
  return { dependencyDir: resolvedDependencyDir };
}

function createTemporaryApp(root, fixture, dependencyDir) {
  const appRoot = join(root, fixture.file.replace(/\.tsx$/, ''));
  const sourceDir = join(appRoot, 'src');
  const componentName = fixture.kind === 'guard' ? 'Root' : 'App';
  mkdirSync(sourceDir, { recursive: true });
  cpSync(join(fixtureRoot, fixture.file), join(sourceDir, 'fixture.tsx'));
  symlinkSync(dependencyDir, join(appRoot, 'node_modules'), 'dir');
  writeFileSync(join(appRoot, 'index.html'), `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8"><title>Frontend GUI browser check</title></head>
  <body><div id="root"></div><script type="module" src="/src/entry.tsx"></script></body>
</html>
`);
  writeFileSync(join(sourceDir, 'entry.tsx'), `import React from 'react';
import { createRoot } from 'react-dom/client';
import { ${componentName} } from './fixture.tsx';

createRoot(document.getElementById('root')).render(<${componentName} />);
`);
  return appRoot;
}

async function startServer(appRoot, dependencyDir) {
  const servingRoot = realpathSync(appRoot);
  const servingDependencies = realpathSync(dependencyDir);
  const server = await createServer({
    root: servingRoot,
    logLevel: 'error',
    esbuild: { jsx: 'automatic' },
    server: {
      host: '127.0.0.1',
      port: 0,
      strictPort: false,
      fs: { allow: [servingRoot, servingDependencies] },
    },
  });
  await server.listen();
  const url = server.resolvedUrls?.local?.[0];
  if (url === undefined) {
    await server.close();
    throw new Error(`Vite did not expose a local URL for ${appRoot}`);
  }
  return { server, url };
}

async function readCount(page, label) {
  const value = await page.locator(`output[aria-label="${label}"]`).textContent();
  assert.notEqual(value, null, `${label} output is missing`);
  const count = Number(value);
  assert.equal(Number.isInteger(count), true, `${label} output is not an integer`);
  return count;
}

async function waitForText(locator, expected, description) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (await locator.textContent() === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(await locator.textContent(), expected, description);
}

async function assertSavingPersistsWhileWallClockRuns(status, description) {
  const startedAt = Date.now();
  await new Promise((resolve) => setTimeout(resolve, SAVE_DELAY_MS * 2));
  assert.equal(Date.now() >= startedAt + SAVE_DELAY_MS, true, `${description} wall-clock wait was too short`);
  await waitForText(status, 'saving', `${description} advanced without the emulated clock`);
}

async function isFocused(page, locator) {
  return locator.evaluate((element) => element === document.activeElement);
}

async function reloadPage(page) {
  await page.reload({ waitUntil: 'networkidle' });
}

async function openSaveModal(page, fixture) {
  const trigger = page.getByRole('button', { name: 'Open save confirmation' });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Save changes?' });
  await assertVisible(dialog, `${fixture.file} save dialog`);
  assert.equal(
    await dialog.evaluate((element) => element.contains(document.activeElement)),
    true,
    `${fixture.file} did not move focus inside the dialog on open`,
  );
  return { trigger, dialog };
}

async function reachBackgroundWithKeyboard(page, background, key) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (await isFocused(page, background)) return true;
    await page.keyboard.press(key);
  }
  return isFocused(page, background);
}

async function verifyConfirmation(page, fixture) {
  const draft = page.getByLabel('Draft', { exact: true });
  await draft.fill('Edited');
  await page.getByRole('button', { name: 'Save draft' }).click();
  assert.equal(await readCount(page, 'Save count'), 1, `${fixture.file} save callback is not connected`);
  assert.equal(await page.getByLabel('Saved content').textContent(), 'Edited', `${fixture.file} positive save changed no content`);
  await draft.fill('Changed');
  await page.getByRole('button', { name: 'Open discard confirmation' }).click();
  const dialog = page.getByRole('dialog', { name: 'Discard draft?' });
  await assertVisible(dialog, 'confirmation dialog');

  await page.getByRole('button', { name: 'Save draft' }).evaluate((element) => element.click());
  assert.equal(
    await readCount(page, 'Save count'),
    fixture.saveCount,
    `${fixture.file} changed the save count while confirmation was open`,
  );
  assert.equal(await page.getByLabel('Saved content').textContent(), fixture.savedContent, `${fixture.file} changed saved content`);
  await dialog.getByRole('button', { name: 'Keep editing' }).click();
  await assertHidden(dialog, 'confirmation dialog after cancel');
}

async function verifyGuard(page, fixture) {
  await reloadPage(page);
  await page.clock.install();
  await page.clock.pauseAt(await page.evaluate(() => Date.now()));
  const save = page.getByRole('button', { name: 'Save', exact: true });
  const saveEmpty = page.getByRole('button', { name: 'Save empty', exact: true });
  const status = page.getByLabel('Save status', { exact: true });
  const feedback = page.getByLabel('Save feedback', { exact: true });
  const savedName = page.getByLabel('Saved name', { exact: true });

  await waitForText(status, 'editing', `${fixture.file} did not start in editing state`);
  await waitForText(savedName, 'none', `${fixture.file} did not start with an empty saved name sentinel`);
  await waitForText(feedback, '', `${fixture.file} did not start without feedback`);

  await saveEmpty.click();
  if (fixture.emptySaveAccepted) {
    await waitForText(status, 'saving', `${fixture.file} did not enter saving for the empty request`);
    await assertSavingPersistsWhileWallClockRuns(status, `${fixture.file} empty save`);
    await page.clock.runFor(SAVE_DELAY_MS);
    await waitForText(status, 'editing', `${fixture.file} did not complete the empty request`);
    await waitForText(savedName, '', `${fixture.file} did not expose the defective empty save result`);
  } else {
    await waitForText(status, 'editing', `${fixture.file} changed status for a rejected empty request`);
    await waitForText(feedback, 'Name is required', `${fixture.file} did not report the empty input`);
    await waitForText(savedName, 'none', `${fixture.file} saved an empty name`);
  }

  await save.click();
  await waitForText(status, 'saving', `${fixture.file} did not enter saving for a valid request`);
  assert.equal(await save.isDisabled(), true, `${fixture.file} left the active Save button enabled while saving`);
  await waitForText(feedback, '', `${fixture.file} kept a stale rejection message after accepting a save`);
  await assertSavingPersistsWhileWallClockRuns(status, `${fixture.file} valid save`);
  await page.clock.runFor(SAVE_DELAY_MS);
  await waitForText(status, 'editing', `${fixture.file} did not return to editing after a valid save`);
  await waitForText(savedName, 'Ada', `${fixture.file} did not display the saved name`);

  await save.click();
  await waitForText(status, 'saving', `${fixture.file} did not start the second valid save`);
  assert.equal(await saveEmpty.isEnabled(), true, `${fixture.file} removed the process-time empty-input path`);
  await saveEmpty.click();
  await assertSavingPersistsWhileWallClockRuns(status, `${fixture.file} in-flight save`);
  await page.clock.runFor(SAVE_DELAY_MS);
  await waitForText(status, 'editing', `${fixture.file} did not finish the in-flight save`);
  await waitForText(savedName, fixture.savedAfterBusy, `${fixture.file} had an unexpected result after an in-flight empty request`);
  await waitForText(feedback, '', `${fixture.file} left transient rejection feedback after completion`);
  assert.equal(
    (await savedName.textContent()) === '',
    fixture.busyEmptySaveAccepted,
    `${fixture.file} did not exercise the expected process-time empty request path`,
  );

  await save.click();
  await waitForText(status, 'saving', `${fixture.file} did not allow a save after completion`);
  await page.clock.runFor(SAVE_DELAY_MS);
  await waitForText(status, 'editing', `${fixture.file} did not complete the save after completion`);
  await waitForText(savedName, 'Ada', `${fixture.file} did not display the name after re-saving`);
  return {
    emptySaveAccepted: fixture.emptySaveAccepted,
    busyEmptySaveAccepted: fixture.busyEmptySaveAccepted,
    savedAfterBusy: fixture.savedAfterBusy,
    resavedName: 'Ada',
  };
}

async function verifyModalRequestGuard(page, fixture) {
  await reloadPage(page);
  const { trigger, dialog } = await openSaveModal(page, fixture);
  await trigger.evaluate((element) => element.click());
  assert.equal(
    await readCount(page, 'Accepted save requests'),
    fixture.acceptedRequests,
    `${fixture.file} accepted an unexpected repeated request`,
  );
  assert.equal(await readCount(page, 'Saved operations'), 0, `${fixture.file} saved during a repeated request`);
  assert.equal(await readCount(page, 'Background actions'), 0, `${fixture.file} changed the background during a repeated request`);
  await assertVisible(dialog, `${fixture.file} dialog after repeated request`);
  return { acceptedRequests: fixture.acceptedRequests, savedOperations: 0, backgroundActions: 0 };
}

async function verifyModalBackgroundClick(page, fixture) {
  await reloadPage(page);
  const background = page.getByRole('button', { name: 'Background action' });
  await background.click();
  assert.equal(await readCount(page, 'Background actions'), 1, `${fixture.file} background action positive control failed`);
  await openSaveModal(page, fixture);
  const box = await background.boundingBox();
  if (box === null) {
    throw new Error(`${fixture.file} background button has no clickable bounding box`);
  }
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  assert.equal(
    await readCount(page, 'Background actions'),
    fixture.backgroundActions,
    `${fixture.file} exposed an unexpected background click while modal was open`,
  );
  return { positiveControl: 1, modalClickResult: fixture.backgroundActions };
}

async function verifyModalKeyboardTraversal(page, fixture, key, label) {
  await reloadPage(page);
  const { dialog } = await openSaveModal(page, fixture);
  const background = page.getByRole('button', { name: 'Background action' });
  const backgroundFocused = await reachBackgroundWithKeyboard(page, background, key);
  assert.equal(
    backgroundFocused,
    !fixture.backgroundBlocked,
    `${fixture.file} did not establish the expected background focus boundary for ${label}`,
  );
  if (backgroundFocused) await page.keyboard.press('Enter');
  assert.equal(
    await readCount(page, 'Background actions'),
    backgroundFocused ? 1 : 0,
    `${fixture.file} exposed an unexpected background action during ${label}`,
  );
  await assertVisible(dialog, `${fixture.file} dialog after ${label}`);
  return { backgroundFocused, backgroundActions: backgroundFocused ? 1 : 0 };
}

async function verifyModalEscape(page, fixture) {
  await reloadPage(page);
  const { trigger, dialog } = await openSaveModal(page, fixture);
  await dialog.getByRole('button', { name: 'Cancel' }).focus();
  await page.keyboard.press('Escape');
  await assertHidden(dialog, `${fixture.file} save dialog after Escape`);
  assert.equal(await isFocused(page, trigger), true, `${fixture.file} did not restore focus to its trigger after Escape`);
  return { dialogClosed: true, triggerFocused: true };
}

async function verifyModalConfirm(page, fixture) {
  await reloadPage(page);
  const { dialog } = await openSaveModal(page, fixture);
  await dialog.getByRole('button', { name: 'Confirm save' }).click();
  assert.equal(await readCount(page, 'Saved operations'), 1, `${fixture.file} did not complete the save`);
  assert.equal(await readCount(page, 'Accepted save requests'), fixture.acceptedRequests, `${fixture.file} accepted an unexpected save count`);
  return { savedOperations: 1, acceptedRequests: fixture.acceptedRequests };
}

async function verifyModal(page, fixture) {
  return {
    requestGuard: await verifyModalRequestGuard(page, fixture),
    backgroundClick: await verifyModalBackgroundClick(page, fixture),
    forwardTab: await verifyModalKeyboardTraversal(page, fixture, 'Tab', 'forward Tab'),
    reverseTab: await verifyModalKeyboardTraversal(page, fixture, 'Shift+Tab', 'reverse Shift+Tab'),
    escapeFocusReturn: await verifyModalEscape(page, fixture),
    confirmSave: await verifyModalConfirm(page, fixture),
  };
}

async function assertVisible(locator, description) {
  assert.equal(await locator.isVisible(), true, `${description} is not visible`);
}

async function assertHidden(locator, description) {
  assert.equal(await locator.isVisible(), false, `${description} is still visible`);
}

async function verifyFixture(browser, root, fixture, dependencyDir) {
  const appRoot = createTemporaryApp(root, fixture, dependencyDir);
  const { server, url } = await startServer(appRoot, dependencyDir);
  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: 'networkidle' });
    if (fixture.kind === 'confirmation') {
      await verifyConfirmation(page, fixture);
      return { file: fixture.file, pass: true, checks: { positiveSaveAndPendingSave: true } };
    } else if (fixture.kind === 'guard') {
      const checks = await verifyGuard(page, fixture);
      return { file: fixture.file, pass: true, checks };
    } else {
      const checks = await verifyModal(page, fixture);
      return { file: fixture.file, pass: true, checks };
    }
  } finally {
    await page.close();
    await server.close();
  }
}

async function main() {
  const { dependencyDir } = parseOptions(process.argv.slice(2));
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'takt-frontend-gui-browser-'));
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const results = [];
    for (const fixture of CASES) {
      results.push(await verifyFixture(browser, temporaryRoot, fixture, dependencyDir));
    }
    console.log(JSON.stringify(results, null, 2));
  } finally {
    if (browser !== undefined) await browser.close();
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
