# TAKT

[English](../README.md) | 💬 [Discord コミュニティ](https://discord.gg/R2Xz3uYWxD)

**T**AKT **A**gent **K**oordination **T**opology — AI コーディングエージェントにレビューループ・プロンプト管理・ガードレールを与え、「とりあえず動くコード」ではなく「品質の高いコード」を出させるツールです。

AI と会話してやりたいことを決め、タスクとして積み、`takt run` で実行します。計画・実装・レビュー・修正のループは YAML の workflow ファイルで定義されており、エージェント任せにはしません。Claude Code、Codex、OpenCode、Cursor、GitHub Copilot CLI に対応しています。

TAKT は TAKT 自身で開発しています（ドッグフーディング）。

## なぜ TAKT か

**すぐ始められる** — アーキテクチャ、セキュリティ、AI アンチパターンなどのレビュー観点をビルトインで備えています。インストールしたその日から、一定以上の品質のコードを出せます。

**実用的** — 日々の開発で使うためのツールです。AI と相談して要件を固め、タスクを積んで実行します。タスク実行時のワークツリー隔離、PR 作成、失敗時のリトライまで面倒を見てくれます。

**再現可能** — 実行パスを YAML で宣言するから、結果のブレを抑えられます。workflow は共有できるので、チームの誰かが作ったワークフローを他のメンバーがそのまま使って同じ品質プロセスを回せます。すべてのステップは NDJSON でログに残るため、タスクから PR まで追跡もできます。

**マルチエージェント** — 異なるペルソナ・権限・レビュー基準を持つ複数のエージェントを協調させます。並列レビュー、失敗時の差し戻し、ルールによる結果の集約に対応しています。プロンプトは persona・policy・knowledge・instruction の独立したファセットとして管理し、ワークフロー間で自由に組み合わせられます（[Faceted Prompting](./faceted-prompting.ja.md)）。

## 必要なもの

次のいずれかが必要です。

- **プロバイダー CLI**: [Claude Code](https://claude.ai/code)（デフォルトの `claude` プロバイダ）、[Codex](https://github.com/openai/codex)、[OpenCode](https://opencode.ai)、[Cursor Agent](https://docs.cursor.com/)、[GitHub Copilot CLI](https://docs.github.com/en/copilot/github-copilot-in-the-cli) のいずれか
- **API Key 直接利用**: OpenAI / OpenCode の API Key があれば CLI は不要です

任意:

- [GitHub CLI](https://cli.github.com/) (`gh`) — `takt #N` で GitHub Issue を使う場合に必要です
- [GitLab CLI](https://gitlab.com/gitlab-org/cli) (`glab`) — GitLab Issue/MR 連携に使います（リモート URL から自動検出）

> **OAuth・API キーの利用について:** OAuth や API キーが利用可能かどうかはプロバイダーや用途によって異なります。TAKT を利用する際には、各プロバイダーの利用規約をご確認ください。

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
# タスクブランチの一覧を確認し、マージ、リトライ、強制失敗、削除ができます
takt list
```

## 仕組み

TAKT は音楽のメタファーを使っています。TAKT という名前自体が、オーケストラの指揮で拍を刻む「タクト（Takt）」に由来しています。TAKT はユーザー向けにも実装名にも **workflow** と **step** を使います。

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

ルールが次の step を決めます。`COMPLETE` でワークフロー成功終了、`ABORT` で失敗終了です。並列 step やルール条件の詳細は [Workflow Guide](./workflows.md) を参照してください。

workflow ファイルの正式ディレクトリ名は `workflows/` です。

同名 workflow が複数箇所にある場合の探索順は `.takt/workflows/` → `~/.takt/workflows/` → builtin です。

## おすすめワークフロー

| Workflow | 用途 |
|-------|------|
| `default` | 標準の開発 workflow です。テスト先行＋AIアンチパターンレビュー＋並列レビュー（アーキテクチャ＋スーパーバイザー）の構成です。 |
| `frontend-mini` | フロントエンド向けの mini 構成です。 |
| `backend-mini` | バックエンド向けの mini 構成です。 |
| `dual-mini` | フロントエンド＋バックエンド向けの mini 構成です。 |

全ワークフロー・ペルソナの一覧は [Builtin Catalog](./builtin-catalog.ja.md) を参照してください。

## 主要コマンド

| コマンド | 説明 |
|---------|------|
| `takt` | AI と相談して、タスクを実行または積みます |
| `takt run` | 積まれたタスクをまとめて実行します |
| `takt list` | タスクブランチを管理します（マージ、リトライ、強制失敗、追加指示、削除） |
| `takt #N` | GitHub Issue をタスクとして実行します |
| `takt eject` | ビルトインの workflow/facet をコピーしてカスタマイズできます |
| `takt workflow init` | カスタム workflow のひな形を作成します |
| `takt workflow doctor` | カスタム workflow の定義を静的検証します |
| `takt repertoire add` | GitHub から repertoire パッケージをインストールします |

全コマンド・オプションは [CLI Reference](./cli-reference.ja.md) を参照してください。

## 設定

最小限の `~/.takt/config.yaml` は次の通りです。

```yaml
provider: claude    # claude, claude-sdk, codex, opencode, cursor, or copilot
model: sonnet       # プロバイダーにそのまま渡されます
language: ja        # en or ja
```

API Key を直接使う場合は、CLI のインストールは不要です（Claude、Codex、OpenCode が対象）。

```bash
export TAKT_ANTHROPIC_API_KEY=sk-ant-...   # Anthropic (Claude)
export TAKT_OPENAI_API_KEY=sk-...          # OpenAI (Codex)
export TAKT_OPENCODE_API_KEY=...           # OpenCode
export TAKT_CURSOR_API_KEY=...             # Cursor Agent（login 済みなら省略可）
export TAKT_COPILOT_GITHUB_TOKEN=ghp_...   # GitHub Copilot CLI
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

詳細は [Workflow Guide](./workflows.md) と [Agent Guide](./agents.md) を参照してください。

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

## API

```typescript
import { WorkflowEngine, loadWorkflow } from 'takt';

const config = loadWorkflow('default', process.cwd());
if (!config) throw new Error('Workflow not found');

const engine = new WorkflowEngine(config, process.cwd(), 'My task');
await engine.run();
```

## ドキュメント

| ドキュメント | 内容 |
|-------------|------|
| [CLI Reference](./cli-reference.ja.md) | 全コマンド・オプション |
| [Configuration](./configuration.ja.md) | グローバル設定・プロジェクト設定 |
| [Workflow Guide](./workflows.md) | workflow の作成・カスタマイズ |
| [Agent Guide](./agents.md) | カスタムエージェントの設定 |
| [Builtin Catalog](./builtin-catalog.ja.md) | ビルトイン workflow・persona の一覧 |
| [Faceted Prompting](./faceted-prompting.ja.md) | プロンプト設計の方法論 |
| [Repertoire Packages](./repertoire.ja.md) | パッケージのインストール・共有 |
| [Task Management](./task-management.ja.md) | タスクの追加・実行・隔離 |
| [データフロー](./data-flow.md) | 内部データフローとアーキテクチャ図 |
| [CI/CD Integration](./ci-cd.ja.md) | GitHub Actions・パイプラインモード |
| [Provider Sandbox & Permissions](./provider-sandbox.md) | Codex / OpenCode / Claude のサンドボックス、パーミッション、ネットワーク設定 |
| [Changelog](../CHANGELOG.md) ([日本語](./CHANGELOG.ja.md)) | バージョン履歴 |
| [Security Policy](../SECURITY.md) | 脆弱性の報告 |

## コミュニティ

質問・議論・最新情報は [TAKT Discord](https://discord.gg/R2Xz3uYWxD) へどうぞ。

## コントリビュート

[CONTRIBUTING.md](../CONTRIBUTING.md) を参照してください。

## ライセンス

MIT — [LICENSE](../LICENSE) を参照してください。
