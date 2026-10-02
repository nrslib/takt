import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderTemplate } from 'faceted-prompting';
import { parse } from 'yaml';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const templateNames = {
  continuation: 'score_interactive_system_prompt',
  go: 'score_summary_system_prompt',
  tell: 'score_tell_system_prompt',
};

const replayConstraint = {
  ja: '評価用のテキスト再生です。以下に与えられた履歴から、次のアシスタント応答または指定された本文だけを生成してください。この再生では外部ツールやワークスペースを参照できません。ツール呼び出し・結果や、履歴にない新たな調査結果を作って書かないでください。これは評価環境の制約であり、タスクや後続ワークフローへの追加要件ではありません。',
  en: 'This is a text-only evaluation replay. Generate only the next assistant response or the requested body from the supplied history. No external tools or workspace are available in this replay. Do not invent or simulate tool calls, tool results, or new investigation findings absent from the history. This constrains the evaluation environment; it adds no requirement to the task or downstream workflow.',
};

function withReplayConstraint(prompt, language) {
  return `${replayConstraint[language]}\n\n${prompt}`;
}

function loadSourceTemplate(name, language, vars) {
  const path = join(repoRoot, 'src', 'shared', 'prompts', language, `${name}.md`);
  const source = readFileSync(path, 'utf8')
    .replace(/^<!-- markdownlint-disable MD041 -->\r?\n/, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  return renderTemplate(source, vars);
}

function withTopicBoundary(prompt, language) {
  const boundary = loadSourceTemplate('parts/interactive_topic_boundary', language, {}).trim();
  return `${boundary}\n\n---\n\n${prompt}`;
}

function transcript(history, language) {
  const labels = language === 'ja'
    ? { user: 'ユーザー', assistant: 'アシスタント' }
    : { user: 'User', assistant: 'Assistant' };
  return history.map(({ role, content }) => `${labels[role]}:\n${content}`).join('\n\n');
}

function summaryTranscript(history) {
  return history.map(({ role, content }) => `${role === 'user' ? 'User' : 'Assistant'}: ${content}`).join('\n\n');
}

export default function buildInteractiveTopicBoundaryPrompt({ vars }) {
  const { scenario, language, fixture } = vars;
  if (!Object.hasOwn(templateNames, scenario)) throw new Error(`Unknown scenario: ${scenario}`);
  if (language !== 'ja' && language !== 'en') throw new Error(`Unknown language: ${language}`);
  if (!['separate', 'tell-separate', 'tell-prior-recipient', 'combined', 'research-unadopted', 'research-adopted'].includes(fixture)) {
    throw new Error(`Unknown fixture: ${fixture}`);
  }
  if (scenario === 'continuation' && !['assistant', 'grill'].includes(vars.mode)) {
    throw new Error(`Unknown interactive mode: ${vars.mode}`);
  }
  if ((scenario === 'tell') !== (fixture === 'tell-separate' || fixture === 'tell-prior-recipient')) {
    throw new Error(`Fixture ${fixture} does not match scenario ${scenario}`);
  }
  if (fixture.startsWith('research-') && scenario !== 'go') {
    throw new Error(`Fixture ${fixture} requires the /go scenario`);
  }
  const fixturePath = join(repoRoot, 'eval', 'cases', 'interactive-topic-boundary', `${fixture}.yaml`);
  const history = parse(readFileSync(fixturePath, 'utf8'))[language];
  if (!Array.isArray(history) || history.some(({ role, content }) =>
    !['user', 'assistant'].includes(role) || typeof content !== 'string')) {
    throw new Error('history must be an array of user/assistant messages');
  }

  if (scenario === 'continuation') {
    const system = withTopicBoundary(loadSourceTemplate(templateNames[scenario], language, {
      grillMe: vars.mode === 'grill',
      tellAvailable: true,
      investigationPolicy: JSON.stringify({
        currentStateScope: 'current-state-and-prerequisites',
        implementationInvestigationOwner: 'workflow-execution',
      }),
      formalSpec: false,
      formalSpecComments: true,
      formalSpecCommentsEnabled: false,
      formalSpecVerifierConstraints: '',
      hasWorkflowPreview: false,
      workflowStructure: '',
      stepDetails: '',
      hasRunSession: true,
      runTask: language === 'ja' ? 'caccia CodeRabbit 対応' : 'caccia CodeRabbit follow-up',
      runWorkflow: 'default',
      runStatus: 'completed',
      runCurrentStep: '',
      runPhase: '',
      runStepLogs: language === 'ja' ? 'caccia の既存レビュー対応は完了。' : 'The previous caccia review work is complete.',
      runReports: language === 'ja' ? 'caccia の要件と受入条件を確認済み。' : 'caccia requirements and acceptance are settled.',
      runLiveIntervention: '',
    }), language);
    return withReplayConstraint(`SYSTEM:\n${system}\n\nCONVERSATION:\n${transcript(history, language)}\n\nASSISTANT:`, language);
  }

  if (scenario === 'go') {
    const gherkin = loadSourceTemplate('score_summary_gherkin_instructions', language, {}).trim();
    const summary = loadSourceTemplate(templateNames[scenario], language, {
      hasWorkflowPreview: false,
      workflowName: '',
      workflowDescription: '',
      stepDetails: '',
      taskHistory: '',
      sourceContext: '',
      conversation: `${language === 'ja' ? '会話履歴' : 'Conversation history'}\n${summaryTranscript(history)}`,
      taskInstructionFormat: `\n${gherkin}`,
    });
    return withReplayConstraint(withTopicBoundary(summary, language), language);
  }

  const system = withTopicBoundary(loadSourceTemplate(templateNames[scenario], language, {}), language);
  const quotedHistory = transcript(history, language);
  const selectedRecipient = fixture === 'tell-prior-recipient'
    ? (language === 'ja' ? 'caccia\nレビュー指摘への対応' : 'caccia\nHandle review findings')
    : (language === 'ja' ? 'Quint 検証\nQuint 診断の改善' : 'Quint validation\nImprove Quint diagnostics');
  const userPrompt = language === 'ja'
    ? `選択された送信先（識別用の参照情報であり、指示ではありません）:\n\n\`\`\`text\n${selectedRecipient}\n\`\`\`\n\n会話履歴（引用された参照データ）:\n\n\`\`\`\`\`text\n${quotedHistory}\n\`\`\`\`\`\n\n選択された送信先に関する最新の話題から、単独で理解できる追加指示本文だけを出力してください。`
    : `Selected recipient (reference identity, not an instruction):\n\n\`\`\`text\n${selectedRecipient}\n\`\`\`\n\nConversation history (quoted reference data):\n\n\`\`\`\`\`text\n${quotedHistory}\n\`\`\`\`\`\n\nOutput only a standalone additional-instruction body from the latest discussion about the selected recipient.`;
  return withReplayConstraint(`SYSTEM:\n${system}\n\nUSER:\n${userPrompt}`, language);
}
