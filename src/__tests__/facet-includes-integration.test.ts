/**
 * Tests for {{include:<kind>/<name>}} expansion in facet resolution.
 *
 * Covers:
 * - include expansion in instruction, policy, knowledge facets
 * - include after inheritance (extends + include)
 * - missing include error
 * - cyclic include error
 * - inline content (no sourcePath) skips include expansion
 * - project partial overrides builtin partial
 */

import assert from 'node:assert/strict';
import type { ResolvedFacetContent, WorkflowConfig } from '../core/models/types.js';
import { isNormalOrTeamLeaderWorkflowStep } from '../core/models/workflow-types.js';
import { loadWorkflowByIdentifier, resolveWorkflowCallTarget } from '../infra/config/loaders/workflowLoader.js';
import { InstructionBuilder } from '../core/workflow/instruction/InstructionBuilder.js';
import { makeInstructionContext } from './test-helpers.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  resolveRefToContent,
  type FacetResolutionContext,
} from '../infra/config/loaders/resource-resolver.js';
import { loadTemplate } from '../shared/prompts/index.js';

describe('facet include expansion', () => {
  let tempDir: string;
  let context: FacetResolutionContext;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'takt-include-test-'));
    context = { projectDir: tempDir, lang: 'ja' };
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it.each(['ja', 'en'] as const)('%s: builtin instruction includes reference existing partials', (language) => {
    const facetsRoot = fileURLToPath(new URL(`../../builtins/${language}/facets/`, import.meta.url));
    let references = 0;
    for (const directory of ['instructions', 'partials/instructions']) {
      const root = join(facetsRoot, directory);
      const files = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter(name => name.endsWith('.md'));
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        const body = readFileSync(join(root, file), 'utf8');
        for (const match of body.matchAll(/\{\{include:instructions\/([^}]+)\}\}/g)) {
          const target = join(facetsRoot, 'partials', 'instructions', `${match[1]}.md`);
          expect(statSync(target, { throwIfNoEntry: false })?.isFile(), `${language}/${directory}/${file}: ${match[0]}`).toBe(true);
          references += 1;
        }
      }
    }
    expect(references).toBeGreaterThan(0);
  });

  it.each(['ja', 'en'] as const)('%s: grill-me expands interview partials while the assistant omits them', (lang) => {
    const grill = loadTemplate('score_interactive_system_prompt', lang, { grillMe: true });
    const assistant = loadTemplate('score_interactive_system_prompt', lang, { grillMe: false });
    for (const name of ['decision-question-priority', 'one-question-interview']) {
      const partial = readFileSync(fileURLToPath(new URL(`../../builtins/${lang}/facets/partials/instructions/${name}.md`, import.meta.url)), 'utf8').trim();
      expect(grill).toContain(partial);
      expect(assistant).not.toContain(partial);
    }
    expect(grill).not.toContain('{{include:');
  });

  it.each(['ja', 'en'] as const)('%s: review resolves its shared review procedure partial once', (lang) => {
    const reviewCommon = resolveRefToContent(
      fileURLToPath(new URL(`../../builtins/${lang}/facets/partials/policies/review-common.md`, import.meta.url)),
      undefined, tempDir, 'policies', { projectDir: tempDir, lang });
    expect(reviewCommon).toBeDefined();
    const review = resolveRefToContent('review', undefined, tempDir, 'policies', { projectDir: tempDir, lang });
    expect(review).toBeDefined();
    expect(review?.split(reviewCommon!.trim())).toHaveLength(2);
    expect(review).not.toContain('{{include:');
  });

  it.each(['ja', 'en'] as const)('%s: real repair steps retain mandatory policy decisions in the 2000-character injection', (lang) => {
    const directory = tempDir;
    mkdirSync(join(directory, '.takt'), { recursive: true });
    writeFileSync(join(directory, '.takt/config.yaml'), `language: ${lang}\n`);
    const loadBuiltin = (name: string): WorkflowConfig => {
      const workflow = loadWorkflowByIdentifier(fileURLToPath(new URL(`../../builtins/${lang}/workflows/${name}.yaml`, import.meta.url)), directory);
      assert.ok(workflow, name);
      return workflow;
    };
    const childOf = (parent: WorkflowConfig, name: string): WorkflowConfig => {
      const call = parent.steps.find(step => step.name === name);
      assert.ok(call?.kind === 'workflow_call', name);
      const child = resolveWorkflowCallTarget(parent, call, directory, directory);
      assert.ok(child, name);
      return child;
    };
    const agentOf = (workflow: WorkflowConfig, name: string) => {
      const step = workflow.steps.find(step => step.name === name);
      assert.ok(step && isNormalOrTeamLeaderWorkflowStep(step), name);
      return step;
    };
    const policy = readFileSync(fileURLToPath(new URL(`../../builtins/${lang}/facets/policies/repair-strategy.md`, import.meta.url)), 'utf8').trim();
    const reviewCommonCounts: { label: string; count: number }[] = [];
    const adjudicationFixedPolicies = ['process-deviation', 'review-adjudication', 'repair-strategy', 'architecture', 'takt', 'contract-change'];
    const adjudicationPolicies = [...adjudicationFixedPolicies, 'review'];
    const stages: { step: ReturnType<typeof agentOf>; expectedPolicies: string[]; label: string }[] = [];
    for (const entry of ['peer-review', 'review-fix-simple']) {
      let peer = loadBuiltin(entry);
      if (entry === 'review-fix-simple') peer = childOf(peer, 'reviewers');
      const remediation = childOf(peer, 'remediation');
      const defaults = loadBuiltin('review-remediation');
      const planningPolicies = ['process-deviation', 'repair-strategy', 'contract-change', 'coding', 'testing', 'review',
        ...(entry === 'review-fix-simple' ? ['architecture'] : [])];
      const fixPolicies = ['repair-strategy', 'contract-change', 'coding', 'testing',
        ...(entry === 'review-fix-simple' ? ['ai-antipattern'] : [])];
      const entryStages = [
        { step: agentOf(peer, 'review-adjudication'), expectedPolicies: adjudicationPolicies },
        { step: agentOf(peer, 'final-gate'), expectedPolicies: ['process-deviation', 'repair-strategy', 'contract-change', 'coding', 'testing', 'review', 'architecture',
          ...(entry === 'peer-review' ? ['takt'] : [])] },
        ...['fix-plan', 'fix-replan', 'verification-replan', 'fix-verifier'].map(name => ({
          step: agentOf(remediation, name), expectedPolicies: planningPolicies,
        })),
        ...['fix', 'fix-retry'].map(name => ({ step: agentOf(remediation, name), expectedPolicies: fixPolicies })),
        { step: agentOf(defaults, 'review-adjudication'), expectedPolicies: [...adjudicationFixedPolicies, 'coding', 'testing', 'review'] },
      ];
      assert.equal(entryStages.length, 9);
      stages.push(...entryStages.map(stage => ({ ...stage,
        label: `${lang}/${stage.step === entryStages.at(-1)?.step ? 'review-remediation' : entry}/${stage.step.name}`,
      })));
    }
    // These parents call review-remediation; the peer-review paths above call development-remediation variants without adjudication.
    for (const { entry, planPolicies } of [
      { entry: 'simple', planPolicies: ['review', 'coding', 'testing', 'ai-antipattern'] },
      { entry: 'simple-core', planPolicies: ['review', 'coding', 'testing'] },
      { entry: 'simple-mini', planPolicies: ['coding', 'testing', 'review'] },
      { entry: 'review-fix-backend', planPolicies: ['coding', 'testing', 'review'] },
      { entry: 'review-fix-backend-cqrs', planPolicies: ['coding', 'testing', 'review', 'cqrs-es'] },
      { entry: 'review-fix-frontend', planPolicies: ['coding', 'testing', 'design-fidelity', 'review'] },
      { entry: 'review-fix-dual', planPolicies: ['coding', 'testing', 'design-fidelity', 'screen-api', 'review'] },
      { entry: 'review-fix-dual-cqrs', planPolicies: ['coding', 'testing', 'design-fidelity', 'screen-api', 'review', 'cqrs-es'] },
    ]) {
      const remediation = childOf(loadBuiltin(entry), 'remediation');
      stages.push({ step: agentOf(remediation, 'review-adjudication'),
        expectedPolicies: [...adjudicationFixedPolicies, ...planPolicies],
        label: `${lang}/${entry}/remediation/review-adjudication`,
      });
    }
    assert.equal(stages.length, 26);
    for (const { step, expectedPolicies, label } of stages) {
      const expectedSources = expectedPolicies.map(name => ({
        name, sourcePath: fileURLToPath(new URL(`../../builtins/${lang}/facets/policies/${name}.md`, import.meta.url)),
      }));
      const expectedSourcePaths = expectedSources.map(policy => policy.sourcePath).sort();
      const assertExactPolicies = (policies: readonly ResolvedFacetContent[] | undefined): readonly ResolvedFacetContent[] => {
        assert.ok(policies, `${label}: policyContents must exist`);
        assert.deepEqual(policies.map(policy => policy.sourcePath).sort(), expectedSourcePaths,
          `${label}: policy source paths must match exactly, including multiplicity`);
        return policies;
      };
      const policyContents = assertExactPolicies(step.policyContents);
      assertExactPolicies([...policyContents].reverse());
      assert.throws(() => assertExactPolicies(undefined), { code: 'ERR_ASSERTION', message: `${label}: policyContents must exist` });
      const extraPolicy = { content: 'Unexpected policy', sourcePath: join(directory, 'policies', 'unexpected.md') };
      for (const extras of [[extraPolicy], [extraPolicy, extraPolicy]]) {
        assert.throws(() => assertExactPolicies([...policyContents, ...extras]), { code: 'ERR_ASSERTION' },
          `${label}: unexpected policies must be rejected`);
      }
      for (const { name, sourcePath } of expectedSources) {
        const missing = policyContents.filter(policy => policy.sourcePath !== sourcePath);
        assert.throws(() => assertExactPolicies(missing), { code: 'ERR_ASSERTION' }, `${label}: missing ${name}`);
        const duplicate = policyContents.find(policy => policy.sourcePath === sourcePath);
        assert.ok(duplicate);
        assert.throws(() => assertExactPolicies([...policyContents, duplicate]), { code: 'ERR_ASSERTION' },
          `${label}: duplicate ${name}`);
        const wrongSource = policyContents.map(policy => policy.sourcePath === sourcePath
          ? { ...policy, sourcePath: join(directory, 'policies', `${name}.md`) } : policy);
        assert.throws(() => assertExactPolicies(wrongSource), { code: 'ERR_ASSERTION' }, `${label}: wrong source for ${name}`);
      }
      const contents = policyContents.map(entry => entry.content.trim());
      assert.equal(contents.filter(content => content === policy).length, 1, label);
      const policyPath = join(directory, 'policies.md');
      const combined = policyContents.map(entry => entry.content).join('\n\n---\n\n');
      const reviewCommonContent = resolveRefToContent(fileURLToPath(new URL(`../../builtins/${lang}/facets/partials/policies/review-common.md`, import.meta.url)),
        undefined, directory, 'policies', { projectDir: directory, lang });
      assert.ok(reviewCommonContent);
      const reviewCommon = reviewCommonContent.trim();
      if (step.name === 'review-adjudication' || expectedPolicies.includes('review')) {
        reviewCommonCounts.push({ label, count: combined.split(reviewCommon).length - 1 });
      }
      writeFileSync(policyPath, combined);
      const context = makeInstructionContext({
        task: 'task', iteration: 1, maxSteps: 10, stepIteration: 1,
        cwd: directory, projectCwd: directory, userInputs: [], language: lang, policySourcePath: policyPath,
      });
      const assembled = new InstructionBuilder(step, context).build();
      // StepExecutor supplies one merged snapshot, rather than the original facet array.
      const runtime = new InstructionBuilder(step, { ...context,
        policyContents: [{ content: combined, sourcePath: policyPath }],
      }).build();
      assert.equal(runtime, assembled);
      const end = runtime.lastIndexOf(lang === 'ja' ? '\n...（以下省略）...' : '\n...TRUNCATED...');
      assert.ok(end >= 2000, `${label}: prompt must exercise truncation`);
      const visible = runtime.slice(end - 2000, end);
      assert.equal(visible.length, 2000);
      assert.ok(!visible.includes('policy-priority'), label);
      // Check the actual 2000-character injection, not merely the full snapshot.
      const priorityBlocks = [...combined.matchAll(/<!-- policy-priority -->\s*([\s\S]*?)\s*<!-- \/policy-priority -->/g)]
        .map(match => {
          assert.ok(match[1]);
          return match[1];
        });
      for (const priority of priorityBlocks) {
        assert.ok(visible.includes(priority), `${label}: complete priority block: ${priority.split('\n')[0]}`);
        assert.equal(visible.split(priority).length, 2, `${label}: shared priority appears once`);
      }
      const priorities = [...new Set(priorityBlocks)].join('\n\n');
      const remainder = combined.replace(/<!-- policy-priority -->[\s\S]*?<!-- \/policy-priority -->/g, '').trim();
      const firstBodyParagraph = remainder.split(/\n\s*\n/).find(paragraph => !/^(?:#|---)/.test(paragraph));
      assert.ok(firstBodyParagraph, `${label}: a substantive body paragraph exists`);
      assert.ok(visible.slice(priorities.length + 2).includes(firstBodyParagraph), `${label}: complete opening body paragraph survives`);
      const repairConditions = lang === 'ja' ? [
        /修正済み.*適用範囲内の別の入力・経路で再発.*同じ条件を破る共通の仕組みが確認/,
        /以前の方式.*共通前提を取り除く方式へ切り替える/,
        /初回の指摘.*通常の原因分析.*方針転換は求めない/,
        /原因や守る条件が異なる.*別々に修正.*同じファイルや似た症状だけでは統合しない/,
        /共通原因を解消する計画.*進行中.*不足を埋めて完了/,
      ] : [
        /Resolved defect recurs.*another in-scope input\/path.*same violated condition.*confirmed shared mechanism/,
        /switch to remove shared method assumptions/,
        /First finding.*normal analysis, no history-based switch/,
        /Different causes\/conditions.*separate.*files\/symptoms never suffice to merge/,
        /Shared-cause plan progressing.*fill gaps; finish/,
      ];
      for (const condition of repairConditions) assert.match(visible, condition, label);
      const contractConditions = lang === 'ja' ? [
        /変更対象外.*既存契約を保持/, /現行利用側を新契約へ移行/, /支援対象以外の旧経路を削除/,
        /明示された対象と範囲だけ/, /指定方式・構造・テスト・文書を守り/, /受入条件と実在する安全条件/,
      ] : [
        /Preserve unaffected contracts/, /migrate current consumers/, /remove superseded paths unless explicitly retained/,
        /explicit targets\/scope/, /Honor required methods/, /acceptance\/real safety conditions/,
      ];
      for (const condition of contractConditions) assert.match(visible, condition, label);
      const evidenceConditions = lang === 'ja' ? [
        /提案や繰り返しだけでは元要件・仕様・公開契約の義務にしない/,
        /実在する防御を含む経路で支持・反証/, /防御の時機・効果、正常系の保存/,
        /指定方式・構造・テスト・文書を守り/, /証拠不足は成功にも欠陥にも読み替えない/, /実行・編集権限は維持/,
      ] : [
        /Proposals\/repetition create no requirements\/contracts/,
        /support\/refutation on real guarded paths/, /guard timing\/effects\/success/,
        /Honor required methods\/structure\/tests\/docs/, /No evidence: unknown, not success\/defect/, /Keep authority/,
      ];
      for (const condition of evidenceConditions) assert.match(visible, condition, label);
      if (step.name !== 'fix' && step.name !== 'fix-retry') {
        const processConditions = lang === 'ja' ? [
          /やり直しても取り消せず/, /成果物・外部状態に結果が残らず/,
          /現在のコードを指定条件で検証済み/, /停止済み/,
          /不合格・未完了・再計画・中断の理由にしない/, /境界違反.*通常どおり判定/,
        ] : [
          /irreversible by rework/, /no artifact\/external effects/, /current code verified as specified/,
          /and stopped/, /no fail\/incomplete\/replan\/stop/, /boundary violations normally/,
        ];
        for (const condition of processConditions) assert.match(visible, condition, label);
      }
      if (step.name === 'review-adjudication') {
        const adjudicationConditions = lang === 'ja' ? [
          /妥当性と修正の必要性を分ける/,
          /元要件・受入条件への違反.*修正する/,
          /新しい退行.*修正する/, /必要な利用側移行を修正する/,
          /範囲外の前提だけなら必要以上の拡張/, /現在の修正と必要な環境内検証が完了.*外部でしか観測できない場合だけ外部確認待ち/,
        ] : [
          /Separate validity\/repair need/, /Repair requirement\/acceptance breaches/,
          /change regressions/, /required consumer migration/,
          /Out-of-scope premises alone: expansion/, /Await grounded external-only criteria only after current repairs\/necessary local checks pass/,
        ];
        for (const condition of adjudicationConditions) assert.match(visible, condition, label);
      }
      // Regression contract: these existing decisions must survive real stage composition,
      // including the default adjudication with coding/testing/review additions.
      const requiredPolicyConditions: Record<string, RegExp[]> = lang === 'ja' ? {
        'architecture.md': [/上限のない入力.*全件取得・実体化.*制限.*REJECT/],
        'takt.md': [/SDK 固有のエラーハンドリング.*Provider 外.*REJECT/],
        'coding.md': [/速さより丁寧さ.*コードの正確さ/],
        'testing.md': [/5条件.*証拠/, /既存テスト.*検出できない回帰/, /変更前の失敗.*リグレッションテスト/],
        'review.md': [/実コードを確認してから指摘/],
      } : {
        'architecture.md': [/uncapped input.*before limiting.*REJECT/],
        'takt.md': [/SDK-specific error handling.*outside Provider.*REJECT/],
        'coding.md': [/Correctness before speed\/ease/],
        'testing.md': [/all five evidence conditions/, /regressions existing tests miss/, /pre-fix failure/],
        'review.md': [/Check code before findings.*never speculate/],
      };
      for (const { name, sourcePath } of expectedSources) {
        for (const condition of requiredPolicyConditions[`${name}.md`] ?? []) {
          assert.match(visible, condition, `${label}: existing condition in ${sourcePath}`);
        }
      }
      if (step.name === 'review-adjudication') {
        assert.match(visible, lang === 'ja'
          ? /同じ原因・条件・受入条件.*未確認.*利用箇所.*統合/
          : /Merge unvisited consumers sharing an accepted problem's cause\/condition\/acceptance criteria/, label);
      }
      if (step.name === 'final-gate') {
        const report = step.outputContracts?.find(contract => 'name' in contract && contract.name === 'review-resolution.md');
        assert.ok(report && 'format' in report && typeof report.format === 'string');
        const history = report.format.split(lang === 'ja' ? '## 修正の経過' : '## Repair History')[1]?.split('\n\n')[0];
        assert.ok(history);
        for (const column of lang === 'ja'
          ? [/前回の方式と前提/, /共通原因と残った前提/, /今回の方式と最新要求・裁定への適合理由/, /固定版の参照先/]
          : [/Earlier Method and Assumptions/, /Shared Cause and Remaining Assumption/, /Actual Method and Fit to Latest Requirements \/ Adjudication/, /Fixed-Version References/]) {
          assert.match(history, column);
        }
      }
      assert.ok(runtime.includes(policyPath), label);
      assert.ok(!step.instruction.includes('{{include:'));
    }
    for (const { label, count } of reviewCommonCounts) {
      expect.soft(count, `${label}: review-common must appear once`).toBe(1);
    }
  });

  it.each(['ja', 'en'] as const)('%s: manager excludes shared interview partials and ignores their project overrides', (lang) => {
    const managerContext = { projectDir: tempDir, lang };
    const managerFacets = (['policies', 'instructions'] as const).map(kind =>
      resolveRefToContent('manager', undefined, tempDir, kind, managerContext));
    for (const facet of managerFacets) {
      expect(facet).toBeDefined();
    }
    const manager = managerFacets.join('\n\n');
    const partialsDir = join(tempDir, '.takt', 'facets', 'partials', 'instructions');
    mkdirSync(partialsDir, { recursive: true });

    for (const name of ['decision-question-priority', 'one-question-interview']) {
      const partial = readFileSync(fileURLToPath(new URL(`../../builtins/${lang}/facets/partials/instructions/${name}.md`, import.meta.url)), 'utf8').trim();
      expect(manager).not.toContain(partial);
      writeFileSync(join(partialsDir, `${name}.md`), `Project override for ${name}`);
    }
    const managerWithOverrides = (['policies', 'instructions'] as const).map(kind =>
      resolveRefToContent('manager', undefined, tempDir, kind, managerContext));
    expect(managerWithOverrides).toEqual(managerFacets);
    expect(manager).not.toContain('{{include:');
  });

  it('should expand {{include:instructions/<name>}} in an instruction facet', () => {
    const instructionsDir = join(tempDir, '.takt', 'facets', 'instructions');
    const partialsDir = join(tempDir, '.takt', 'facets', 'partials', 'instructions');
    mkdirSync(instructionsDir, { recursive: true });
    mkdirSync(partialsDir, { recursive: true });

    const base = 'Do the task.';
    const partial = 'Shared rules content';
    const extra = 'Extra constraints.';
    writeFileSync(join(partialsDir, 'common-rules.md'), partial);
    writeFileSync(join(instructionsDir, 'implement-maintenance.md'),
      `${base}\n\n{{include:instructions/common-rules}}\n\n${extra}`);

    const content = resolveRefToContent('implement-maintenance', undefined, tempDir, 'instructions', context);
    expect(content).toContain(base);
    expect(content).toContain(partial);
    expect(content).toContain(extra);
    expect(content).not.toContain('{{include:instructions/common-rules}}');
  });

  it('should expand {{include:policies/<name>}} in a policy facet', () => {
    const policiesDir = join(tempDir, '.takt', 'facets', 'policies');
    const partialsDir = join(tempDir, '.takt', 'facets', 'partials', 'policies');
    mkdirSync(policiesDir, { recursive: true });
    mkdirSync(partialsDir, { recursive: true });

    const base = 'Testing policy.';
    const partial = 'No layer duplication.';
    writeFileSync(join(partialsDir, 'layer-dedup.md'), partial);
    writeFileSync(join(policiesDir, 'testing-mild.md'),
      `${base}\n\n{{include:policies/layer-dedup}}`);

    const content = resolveRefToContent('testing-mild', undefined, tempDir, 'policies', context);
    expect(content).toContain(base);
    expect(content).toContain(partial);
    expect(content).not.toContain('{{include:policies/layer-dedup}}');
  });

  it('should expand {{include:knowledge/<name>}} in a knowledge facet', () => {
    const knowledgeDir = join(tempDir, '.takt', 'facets', 'knowledge');
    const partialsDir = join(tempDir, '.takt', 'facets', 'partials', 'knowledge');
    mkdirSync(knowledgeDir, { recursive: true });
    mkdirSync(partialsDir, { recursive: true });

    const base = 'Backend knowledge.';
    const partial = 'Architecture overview.';
    writeFileSync(join(partialsDir, 'common-arch.md'), partial);
    writeFileSync(join(knowledgeDir, 'backend-extended.md'),
      `${base}\n\n{{include:knowledge/common-arch}}`);

    const content = resolveRefToContent('backend-extended', undefined, tempDir, 'knowledge', context);
    expect(content).toContain(base);
    expect(content).toContain(partial);
    expect(content).not.toContain('{{include:knowledge/common-arch}}');
  });

  it('should expand includes after inheritance (extends then include)', () => {
    const instructionsDir = join(tempDir, '.takt', 'facets', 'instructions');
    const partialsDir = join(tempDir, '.takt', 'facets', 'partials', 'instructions');
    mkdirSync(instructionsDir, { recursive: true });
    mkdirSync(partialsDir, { recursive: true });

    const base = 'Base instruction with';
    const partial = 'CHECK PASSED';
    const child = 'Child additions.';
    writeFileSync(join(instructionsDir, 'base.md'), `${base} {{include:instructions/shared-check}}.`);
    writeFileSync(join(partialsDir, 'shared-check.md'), partial);
    writeFileSync(join(instructionsDir, 'child.md'),
      `{extends:base}\n\n${child}`);

    const content = resolveRefToContent('child', undefined, tempDir, 'instructions', context);
    expect(content).toContain(base);
    expect(content).toContain(partial);
    expect(content).toContain(child);
    expect(content).not.toContain('{{include:instructions/shared-check}}');
  });

  it('should throw on missing include', () => {
    const instructionsDir = join(tempDir, '.takt', 'facets', 'instructions');
    mkdirSync(instructionsDir, { recursive: true });

    writeFileSync(join(instructionsDir, 'broken.md'),
      'Before.\n\n{{include:instructions/nonexistent}}\n\nAfter.');

    expect(() => resolveRefToContent('broken', undefined, tempDir, 'instructions', context))
      .toThrow();
  });

  it('should throw on cyclic includes', () => {
    const instructionsDir = join(tempDir, '.takt', 'facets', 'instructions');
    const partialsDir = join(tempDir, '.takt', 'facets', 'partials', 'instructions');
    mkdirSync(instructionsDir, { recursive: true });
    mkdirSync(partialsDir, { recursive: true });

    writeFileSync(join(instructionsDir, 'cyclic.md'), '{{include:instructions/first}}');
    writeFileSync(join(partialsDir, 'first.md'), '{{include:instructions/second}}');
    writeFileSync(join(partialsDir, 'second.md'), '{{include:instructions/first}}');

    expect(() => resolveRefToContent('cyclic', undefined, tempDir, 'instructions', context))
      .toThrow();
  });

  it('should NOT expand includes in inline content (no sourcePath)', () => {
    const resolvedMap = { 'my-policy': 'Inline with {{include:policies/something}}' };
    const content = resolveRefToContent('my-policy', resolvedMap, tempDir, 'policies', context);
    expect(content).toBe('Inline with {{include:policies/something}}');
  });

  it('should prefer project partial over builtin partial with the same name', () => {
    const instructionsDir = join(tempDir, '.takt', 'facets', 'instructions');
    const projectPartialsDir = join(tempDir, '.takt', 'facets', 'partials', 'instructions');
    mkdirSync(instructionsDir, { recursive: true });
    mkdirSync(projectPartialsDir, { recursive: true });

    writeFileSync(join(projectPartialsDir, 'implement-common.md'), 'Project version');
    writeFileSync(join(instructionsDir, 'test.md'),
      '{{include:instructions/implement-common}}');

    const content = resolveRefToContent('test', undefined, tempDir, 'instructions', context);
    expect(content).toBe('Project version');
  });

  it('should resolve includes from the source facet layer in package workflows', () => {
    const repertoireDir = join(tempDir, 'repertoire');
    const workflowDir = join(repertoireDir, '@nrslib', 'pkg', 'workflows');
    context = { projectDir: tempDir, lang: 'ja', workflowDir, repertoireDir };

    const instructionsDir = join(tempDir, '.takt', 'facets', 'instructions');
    const projectPartialsDir = join(tempDir, '.takt', 'facets', 'partials', 'instructions');
    const packagePartialsDir = join(repertoireDir, '@nrslib', 'pkg', 'facets', 'partials', 'instructions');
    mkdirSync(instructionsDir, { recursive: true });
    mkdirSync(projectPartialsDir, { recursive: true });
    mkdirSync(packagePartialsDir, { recursive: true });

    writeFileSync(join(packagePartialsDir, 'shared.md'), 'Package version');
    writeFileSync(join(projectPartialsDir, 'shared.md'), 'Project version');
    writeFileSync(join(instructionsDir, 'test.md'), '{{include:instructions/shared}}');

    const content = resolveRefToContent('test', undefined, workflowDir, 'instructions', context);
    expect(content).toBe('Project version');
  });

});
