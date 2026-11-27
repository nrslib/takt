import assert from 'node:assert/strict';
import { toJSONSchema } from 'zod/v4';
import { buildManagerCurrentInput, loadManagerCase, managerWriteSchemas } from '../manager-work-split-prompt.mjs';

export default class ManagerWorkSplitOfflineProvider {
  id() {
    return 'manager-work-split:offline';
  }

  async callApi(prompt, { vars }) {
    const fixture = loadManagerCase(vars.case, vars.lang);
    if (fixture.execution === true) {
      assert.deepEqual(JSON.parse(prompt), { case: vars.case, lang: vars.lang, user: fixture.user });
      return { output: `${vars.case}/${vars.lang}` };
    }
    assert.ok(prompt.startsWith('SYSTEM:\n'));
    assert.ok(prompt.includes(`Repository: ${JSON.stringify(fixture.cwd)}`));
    assert.ok(prompt.includes(`Concurrency limit: ${fixture.concurrency}`));
    assert.doesNotMatch(prompt, /\{\{include:|llm-rubric/);
    const tools = JSON.parse(prompt.split('TOOLS:\n')[1].split('\n\nUSER:')[0]);
    assert.deepEqual(tools, Object.fromEntries(Object.entries(managerWriteSchemas).map(([name, schema]) =>
      [name, toJSONSchema(schema, { unrepresentable: 'any', io: 'input' })])));
    const label = vars.lang === 'ja' ? 'このターンで既に読んだ結果' : 'Results already read this turn';
    const reads = JSON.parse(prompt.split(`${label}:\n`)[1].split('\n\n')[0]);
    assert.equal(reads.length, fixture.readResults.length);
    assert.deepEqual(reads.map(({ tool }) => tool), fixture.readResults.map(({ tool }) => tool));
    const input = prompt.split('USER:\n')[1].split(/\n\n(?:このターンで既に読んだ結果|Results already read this turn):\n/)[0];
    assert.equal(input, buildManagerCurrentInput(fixture));
    return { output: `${vars.case}/${vars.lang}` };
  }
}
