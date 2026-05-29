# TAKT

[English](../README.md) | 💬 [Discord コミュニティ](https://discord.gg/R2Xz3uYWxD)

**T**AKT **A**gent **K**oordination **T**opology — 複数の AI エージェントをオーケストレーションし、レビューループ・プロンプト管理・ガードレールを与えるツールです。

AI と会話してやりたいことを決め、タスクとして積み、`takt run` で実行します。計画・実装・レビュー・修正のループは YAML の workflow ファイルで定義されており、エージェント任せにはしません。TAKT は Claude Code、Codex、OpenCode、Cursor、GitHub Copilot CLI、Kiro CLI を、役割・権限・文脈の異なるエージェントとして協調させます。

TAKT は AI コーディングワークフローを主な用途として提供していますが、コーディング以外でも、複数の AI エージェントを協調させたいタスクや、レビュー・判定・フィードバックループによってタスクの精度を高めたい場面で活用できます。

TAKT は TAKT 自身で開発しています（ドッグフーディング）。

## なぜ TAKT か

AI コーディングエージェントは強力ですが、そのままでは安定した開発プロセスにはなりません。長い作業では指示を忘れ、コンテキストが汚染され、実装とレビューの責務が混ざり、同じ指摘を人間が何度も繰り返すことになります。それは人を疲弊させます。

プロンプトや `CLAUDE.md` やスキルにルールを書き足すことは助けになります。しかし、それだけではプロセスを強制できません。AI が守るかどうかを、AI 自身の振る舞いに委ねることになるからです。

TAKT は、AI エージェントをただ信頼するのではなく、外側から制御する対象として扱います。

workflow で工程を定義し、persona・policy・knowledge・instruction・output contract を step ごとに与え、実装、レビュー、修正、再レビューの流れを宣言的に管理します。責務・知識・制約を分け、必要な step の必要なエージェントにだけ渡すことで、コンテキストを肥大化させずにタスクの精度を高めます。

レビューを飛ばせない構造にし、問題があれば修正へ戻し、必要なら人間に判断を戻します。タスクはワークツリーで隔離され、各 step の結果はログとレポートに残るため、タスクから PR までの流れを後から追跡できます。

中核にあるのは「役割・工程・判定・フィードバックループを持つエージェントプロセス」を再利用可能な形で動かすことです。

目的はシンプルです。人間の継続的な介入に依存せず、開発プロセスを再利用可能で、レビュー可能で、再現可能な仕組みにすることです。

## 必要なもの

利用するプロバイダーに応じて、外部 CLI のインストール要否が変わります。

次のプロバイダーを使う場合は CLI 不要です（SDK 経由、Node.js のみで動作）:

- `claude-sdk` — `@anthropic-ai/claude-agent-sdk`
- `codex` — `@openai/codex-sdk`
- `opencode` — `@opencode-ai/sdk`

次のプロバイダーを使う場合は外部 CLI のインストールが必要です:

- `claude` — [Claude Code](https://claude.ai/code)
- `claude-terminal` — [Claude Code](https://claude.ai/code) を対話型ターミナルセッションで駆動（[`tmux`](https://github.com/tmux/tmux) も必要）
- `copilot` — [GitHub Copilot CLI](https://docs.github.com/en/copilot/github-copilot-in-the-cli)
- `cursor` — [Cursor Agent](https://docs.cursor.com/)
- `kiro` — [Kiro CLI](https://kiro.dev/docs/cli/headless/)

任意:

- [GitHub CLI](https://cli.github.com/) (`gh`) — `takt #N` で GitHub Issue を使う場合に必要です
- [GitLab CLI](https://gitlab.com/gitlab-org/cli) (`glab`) — GitLab Issue/MR 連携に使います（リモート URL から自動検出）

> **OAuth の利用について:** OAuth が利用可能かどうかはプロバイダーや用途によって異なります。TAKT を利用する際には、各プロバイダーの利用規約をご確認ください。

## クイックスタート

### インストール

```bash
npm install -g takt
```

### AI と相談してタスクを積む

```
$ takt

Select workflow:
  > 🎼 default (current)
    📁 🚀 クイックスタート/
    📁 🎨 フロントエンド/
    📁 ⚙️ バックエンド/

対話モード - タスク内容を入力してください。
コマンド: /go（実行）, /cancel（終了）

> ユーザー認証を JWT で追加して

[AI が要件を整理してくれます]

> /go

提案されたタスク指示:
  ...

どうしますか？
    実行する
    GitHub Issueを建てる
  > タスクにつむ          # ← 通常フロー
    会話を続ける
```

「タスクにつむ」を選ぶと `.takt/tasks/` にタスクが保存されます。`takt run` で実行すると、隔離されたワークツリー上でワークフロー（計画 → 実装 → レビュー → 修正ループ）が走り、終わったら PR を作成するか聞いてきます。

```bash
# 積んだタスクを実行
takt run

# GitHub Issue からも積めます
takt add #6
takt add #12

# まとめて実行
takt run
```

> **「実行する」を選んだ場合:** ワークツリーは作られず、カレントディレクトリで直接作業が行われます。手早く試したいときに便利ですが、変更がそのままワーキングツリーに入る点に注意してください。

### 結果を管理する

```bash
# タスクブランチの一覧を確認し、マージ、リトライ、リキュー、強制失敗、削除ができます
takt list
```

## 仕組み

TAKT という名前自体が、オーケストラの指揮で拍を刻む「タクト（Takt）」に由来しています。TAKT はユーザー向けにも実装名にも **workflow** と **step** を使います。

workflow は step の並びで構成されます。YAML では `steps`、`initial_step`、`max_steps` を使います。各 step では persona（誰が実行するか）、権限（何を許可するか）、ルール（次にどこへ進むか）を指定します。

```yaml
name: plan-implement-review
initial_step: plan
max_steps: 10

steps:
  - name: plan
    persona: planner
    edit: false
    rules:
      - condition: Planning complete
        next: implement

  - name: implement
    persona: coder
    edit: true
    required_permission_mode: edit
    rules:
      - condition: Implementation complete
        next: review

  - name: review
    persona: reviewer
    edit: false
    rules:
      - condition: Approved
        next: COMPLETE
      - condition: Needs fix
        next: implement    # <- 修正ループ
```

ルールが次の step を決めます。`COMPLETE` でワークフロー成功終了、`ABORT` で失敗終了です。並列 step やルール条件の詳細は [Workflow Guide](./workflows.ja.md) を参照してください。

workflow ファイルの正式ディレクトリ名は `workflows/` です。

同名 workflow が複数箇所にある場合の探索順は `.takt/workflows/` → `~/.takt/workflows/` → builtin です。

## おすすめワークフロー

| Workflow | 用途 |
|-------|------|
| `default` | 標準の開発 workflow。テスト先行＋AI アンチパターンレビュー＋並列レビュー（アーキテクチャ＋スーパーバイザー）の構成。 |
| `frontend` | フロントエンド開発向けの workflow。 |
| `backend` | バックエンド開発向けの workflow。 |
| `dual` | フロントエンド＋バックエンドを同時に進める workflow。 |
| `takt-default` | TAKT 自体の開発で実際に使われている workflow。CLI ツールの開発にそのまま活用できます。 |
| `*-mini` シリーズ | 各 workflow の軽量版（`default-mini` / `frontend-mini` / `backend-mini` / `dual-mini`）。`write_tests` を省いた構成。 |

全ワークフロー・ペルソナの一覧は [Builtin Catalog](./builtin-catalog.ja.md) を参照してください。

## 主要コマンド

| コマンド | 説明 |
|---------|------|
| `takt` | AI と相談して、タスクを実行または積みます |
| `takt run` | 積まれたタスクをまとめて実行します |
| `takt list` | タスクブランチを管理します（マージ、リトライ、リキュー、強制失敗、追加指示、削除） |
| `takt #N` | GitHub Issue をタスクとして実行します |
| `takt eject` | ビルトインの workflow/facet をコピーしてカスタマイズできます |
| `takt workflow init` | カスタム workflow のひな形を作成します |
| `takt workflow doctor` | カスタム workflow の定義を静的検証します |
| `takt repertoire add` | GitHub から repertoire パッケージをインストールします |

全コマンド・オプションは [CLI Reference](./cli-reference.ja.md) を参照してください。

## 設定

最小限の `~/.takt/config.yaml` は次の通りです。

```yaml
provider: codex    # claude, claude-sdk, claude-terminal, codex, opencode, cursor, copilot, kiro, or mock
model: gpt-5.5       # プロバイダーにそのまま渡されます
language: ja        # en or ja
```

API Key を直接使う場合は、CLI のインストールは不要です（Claude、Codex、OpenCode が対象）。

```bash
export TAKT_ANTHROPIC_API_KEY=sk-ant-...   # Anthropic (Claude)
export TAKT_OPENAI_API_KEY=sk-...          # OpenAI (Codex)
export TAKT_OPENCODE_API_KEY=...           # OpenCode
export TAKT_CURSOR_API_KEY=...             # Cursor Agent（login 済みなら省略可）
export TAKT_COPILOT_GITHUB_TOKEN=ghp_...   # GitHub Copilot CLI
export TAKT_KIRO_API_KEY=...               # Kiro CLI
```

全設定項目・プロバイダープロファイル・モデル解決の詳細は [Configuration Guide](./configuration.ja.md) を参照してください。

## カスタマイズ

### カスタム workflow

```bash
takt eject default    # ビルトイン workflow を ~/.takt/workflows/ にコピーして編集できます
takt workflow init my-flow
takt workflow doctor my-flow
```

### カスタム persona

`~/.takt/personas/` に Markdown ファイルを置きます。

```markdown
# ~/.takt/personas/my-reviewer.md
You are a code reviewer specialized in security.
```

workflow から `persona: my-reviewer` で参照できます。

詳細は [Workflow Guide](./workflows.ja.md) を参照してください。ビルトインの persona 一覧は [Builtin Catalog](./builtin-catalog.ja.md) にあります。

## CI/CD

GitHub Actions 向けに [takt-action](https://github.com/nrslib/takt-action) を提供しています。

```yaml
- uses: nrslib/takt-action@main
  with:
    anthropic_api_key: ${{ secrets.TAKT_ANTHROPIC_API_KEY }}
    github_token: ${{ secrets.GITHUB_TOKEN }}
```

他の CI ではパイプラインモードを使います。

```bash
takt --pipeline --task "バグを修正して" --auto-pr
```

セットアップの詳細は [CI/CD Guide](./ci-cd.ja.md) を参照してください。

## プロジェクト構造

```
~/.takt/                    # グローバル設定
├── config.yaml             # プロバイダー、モデル、言語など
├── workflows/              # ユーザー定義の workflow
├── facets/                 # ユーザー定義のファセット（personas, policies, knowledge など）
└── repertoire/               # インストール済み repertoire パッケージ

.takt/                      # プロジェクトレベル
├── config.yaml             # プロジェクト設定
├── workflows/              # プロジェクト定義の workflow
├── facets/                 # プロジェクトのファセット
├── tasks.yaml              # 積まれたタスク
├── tasks/                  # タスクの仕様書
└── runs/                   # 実行レポート、ログ、コンテキスト
```

workflow 定義は `workflows/` 配下に配置します。

## Spec-Driven Development を採用する場合

TAKT は、フェーズ遷移を YAML の状態機械として宣言的に縛り、output contract で各フェーズの成果物を形式化し、並列レビューと fix ループで逸脱を戻します。この構造は、仕様駆動 (Spec-Driven Development, SDD) のように「spec を中心に置く」進め方を採るユーザーにとって特に活きやすい設計になっています。spec をしっかり定義しておけば、AI が勝手にフェーズを飛ばす / 受け入れ条件を落とす / 検証を通さず「完了」を宣言する、といった崩れ方が構造的に起きにくくなります。

SDD で進めたい場合の実装例として、コミュニティから [j5ik2o/takt-sdd](https://github.com/j5ik2o/takt-sdd) が提供されています。要件 → ギャップ分析 → 設計 → タスク → 実装 → 検証 の各フェーズをピースとして整備し、OpenSpec 形式の変更提案フローも同梱されています。1 コマンドで導入できます。

```bash
npx create-takt-sdd
```

コミュニティの他の統合は [External Integrations](./external-integrations.ja.md) を参照してください。

## ドキュメント

| ドキュメント | 内容 |
|-------------|------|
| [チュートリアル](./tutorial.ja.md) | 3 フェーズで題材を改良しながら、タスクを積み、実行し、結果を確認する流れ |
| [CLI Reference](./cli-reference.ja.md) | 全コマンド・オプション |
| [Configuration](./configuration.ja.md) | グローバル設定・プロジェクト設定 |
| [設計思想](./design-philosophy.ja.md) | TAKT が workflow、facet、フィードバックループ、追跡性を重視する理由 |
| [Workflow Guide](./workflows.ja.md) | workflow の作成・カスタマイズ |
| [Builtin Catalog](./builtin-catalog.ja.md) | ビルトイン workflow・persona の一覧 |
| [Faceted Prompting](./faceted-prompting.ja.md) | プロンプト設計の方法論 |
| [Repertoire Packages](./repertoire.ja.md) | パッケージのインストール・共有 |
| [Task Management](./task-management.ja.md) | タスクの追加・実行・隔離 |
| [CI/CD Integration](./ci-cd.ja.md) | GitHub Actions・パイプラインモード |
| [External Integrations](./external-integrations.ja.md) | TAKT コアを変更せずに機能を拡張するコミュニティサンプル（監査ログ等） |
| [Changelog](../CHANGELOG.md) ([日本語](./CHANGELOG.ja.md)) | バージョン履歴 |

## スポンサー

TAKT は [CodeRabbit](https://coderabbit.link/nrslib) の Open Source Support Program によってサポートされています。

<a href="https://coderabbit.link/nrslib">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://victorious-bubble-f69a016683.media.strapiapp.com/White_Typemark_79b9189d19.svg">
    <source media="(prefers-color-scheme: light)" srcset="https://victorious-bubble-f69a016683.media.strapiapp.com/Orange_Typemark_43bf516c9d.svg">
    <img alt="CodeRabbit" src="https://victorious-bubble-f69a016683.media.strapiapp.com/Orange_Typemark_43bf516c9d.svg" height="40">
  </picture>
</a>

## コミュニティ

質問・議論・最新情報は [TAKT Discord](https://discord.gg/R2Xz3uYWxD) へどうぞ。

## コントリビュート

[CONTRIBUTING.md](../CONTRIBUTING.md) を参照してください。

## ライセンス

MIT — [LICENSE](../LICENSE) を参照してください。
