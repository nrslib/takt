[English](./ci-cd.md)

# CI/CD 連携

TAKT は CI/CD パイプラインに統合して、タスク実行、PR レビュー、コード生成を自動化できます。このガイドでは GitHub Actions のセットアップ、pipeline モードのオプション、その他の CI システムでの設定について説明します。

## GitHub Actions

TAKT は GitHub Actions 連携用の公式アクション [takt-action](https://github.com/nrslib/takt-action) を提供しています。

### 完全なワークフロー例

```yaml
name: TAKT

on:
  issue_comment:
    types: [created]

jobs:
  takt:
    if: contains(github.event.comment.body, '@takt')
    runs-on: ubuntu-latest
    permissions:
      contents: write
      issues: write
      pull-requests: write

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Run TAKT
        uses: nrslib/takt-action@main
        with:
          anthropic_api_key: ${{ secrets.TAKT_ANTHROPIC_API_KEY }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
```

### パーミッション

`takt-action` が正しく機能するには次のパーミッションが必要です。

| パーミッション | 用途 |
|-------------|------|
| `contents: write` | ブランチの作成、コミット、コードのプッシュ |
| `issues: write` | Issue の読み取りとコメント |
| `pull-requests: write` | PR の作成と更新 |

## Pipeline モード

`--pipeline` を指定すると、非インタラクティブな pipeline モードが有効になります。ブランチの作成、workflow の実行、コミット、プッシュを自動的に行います。このモードは人的操作が不可能な CI/CD 自動化向けに設計されています。

Pipeline モードにはタスクソースが必須です。`--task`、`--issue`、`--pr` のいずれかを指定してください。いずれも指定しない場合、TAKT は exit code `2` で終了します。

Pipeline モードでは、`--auto-pr` を明示的に指定しない限り PR は作成**されません**。`--auto-pr` を `--skip-git` と併用した場合、PR は作成されず、TAKT は警告を出力します。終了コードはワークフローの結果に従います（ワークフロー自体が成功した場合のみ `0`）。

### Pipeline の全オプション

| オプション | 説明 |
|-----------|------|
| `--pipeline` | **pipeline（非インタラクティブ）モードを有効化** -- CI/自動化に必要 |
| `-t, --task <text>` | タスク内容（GitHub Issue の代替） |
| `-i, --issue <N>` | GitHub Issue 番号（インタラクティブモードでの `#N` と同等） |
| `--pr <number>` | PR 番号（レビューコメントを取得して修正） |
| `-w, --workflow <name or path>` | Workflow 名または workflow YAML ファイルのパス |
| `-b, --branch <name>` | ブランチ名を指定（省略時は自動生成） |
| `--auto-pr` | PR を作成（インタラクティブ: 確認スキップ、pipeline: PR 有効化） |
| `--draft` | PR を draft として作成（`--auto-pr` または `auto_pr` 設定が必要） |
| `--skip-git` | ブランチ作成、コミット、プッシュをスキップ（pipeline モード、workflow のみ実行） |
| `--repo <owner/repo>` | リポジトリを指定（PR 作成用） |
| `-q, --quiet` | 最小出力モード: AI 出力を抑制（CI 向け） |
| `--provider <name>` | エージェント provider を上書き（claude\|claude-sdk\|claude-terminal\|codex\|opencode\|deepseek-harness\|cursor\|copilot\|kiro\|pi\|mock） |
| `--model <name>` | エージェントモデルを上書き |
| `--auto-strategy <strategy>` | 自動ルーティング戦略（cost\|balanced\|performance） |

### コマンド例

**基本的な pipeline 実行**

```bash
takt --pipeline --task "Fix bug"
```

**PR 自動作成付きの pipeline 実行**

```bash
takt --pipeline --task "Fix bug" --auto-pr
```

**GitHub Issue をリンクして PR を作成**

```bash
takt --pipeline --issue 99 --auto-pr
```

**Workflow とブランチ名を指定**

```bash
takt --pipeline --task "Fix bug" -w magi -b feat/fix-bug
```

**PR 作成用にリポジトリを指定**

```bash
takt --pipeline --task "Fix bug" --auto-pr --repo owner/repo
```

**Workflow のみ実行（ブランチ作成、コミット、プッシュをスキップ）**

```bash
takt --pipeline --task "Fix bug" --skip-git
```

`--skip-git` 指定時はプッシュが行われないため、`--auto-pr` は無視されます（警告を出力します）。`--auto-pr` の無視は結果を変えません。ワークフローが失敗した場合は終了コード `3` のままです。

**最小出力モード（CI ログ向けに AI 出力を抑制）**

```bash
takt --pipeline --task "Fix bug" --quiet
```

## Exit Code

Pipeline モードは、CI スクリプトが失敗の種類を区別できるように細分化された exit code を返します。

| Code | 意味 |
|------|------|
| `0` | 成功 |
| `1` | 一般エラー |
| `2` | Issue/PR の取得失敗、または `--issue` / `--pr` / `--task` の未指定 |
| `3` | Workflow の実行失敗 |
| `4` | Git 操作の失敗（環境準備、コミット、プッシュ） |
| `5` | PR 作成の失敗 |
| `130` | SIGINT（Ctrl+C）による中断 |

## Pipeline テンプレート変数

`~/.takt/config.yaml` の pipeline 設定では、コミットメッセージと PR 本文をカスタマイズするためのテンプレート変数をサポートしています。

```yaml
pipeline:
  default_branch_prefix: "takt/"
  commit_message_template: "feat: {title} (#{issue})"
  pr_body_template: |
    ## Summary
    {issue_body}
    Closes #{issue}
```

| 変数 | 使用可能な場所 | 説明 |
|------|--------------|------|
| `{title}` | コミットメッセージ、PR 本文 | Issue タイトル |
| `{issue}` | コミットメッセージ、PR 本文 | Issue 番号 |
| `{issue_body}` | PR 本文 | Issue 本文 |
| `{report}` | PR 本文 | 固定文字列: ``Workflow `{workflow}` completed successfully.`` |

`commit_message_template` は Issue が紐付いている場合にのみ適用されます。`--task` 単独の場合、コミットメッセージは `takt: {task}` になります。

## その他の CI システム

GitHub Actions 以外の CI システムでは、TAKT をグローバルにインストールして pipeline モードを直接使用します。

```bash
# takt のインストール
npm install -g takt

# pipeline モードで実行
takt --pipeline --task "Fix bug" --auto-pr --repo owner/repo
```

このアプローチは Node.js をサポートする任意の CI システムで動作します。GitLab CI、CircleCI、Jenkins、Azure DevOps などが含まれます。

## 環境変数

CI 環境での認証には、該当する場合は適切な API キー環境変数を設定してください。これらは他のツールとの衝突を避けるため TAKT 固有のプレフィックスを使用しますが、公式 provider が指定する名前は例外です。公式 DeepSeek Harness SDK は `DEEPSEEK_API_KEY` と `DEEPSEEK_BASE_URL` を使用します。

```bash
# Claude（Anthropic）用
export TAKT_ANTHROPIC_API_KEY=sk-ant-...

# Codex（OpenAI）用
export TAKT_OPENAI_API_KEY=sk-...

# OpenCode 用
export TAKT_OPENCODE_API_KEY=...

# Pi 用
# Pi SDK の credential store または provider-native 環境変数を使用

# 公式 DeepSeek Harness SDK 用（Python 3.10+。公式名のためプレフィックス規則の例外）
export DEEPSEEK_API_KEY=...
# 任意: export DEEPSEEK_BASE_URL=https://...

# Cursor Agent 用（cursor-agent login 済みなら省略可）
export TAKT_CURSOR_API_KEY=...

# GitHub Copilot CLI 用
export TAKT_COPILOT_GITHUB_TOKEN=ghp_...

# Kiro CLI 用
export TAKT_KIRO_API_KEY=...
```

優先順位: 環境変数は `config.yaml` の設定よりも優先されます。

> **注意**: SDK provider（Claude SDK、Codex、OpenCode、Pi）の認証情報を設定すれば、対応する CLI のインストールは不要です。TAKT が API を直接呼び出します。`deepseek-harness` はさらに Python 3.10+、対応する `deepseek-harness-sdk` / `deepseek-harness-runtime-bin` package、Linux x64/arm64 または macOS arm64 が必要です。Windows と macOS x64 は未対応です。Cursor、Copilot、Kiro は CLI のインストールが必要です。

## コストに関する注意

TAKT は AI API（Anthropic、OpenAI など）を使用するため、特に CI/CD 環境でタスクが自動実行される場合、大きなコストが発生する可能性があります。次の点に注意してください。

- **API 使用量の監視**: 予期しない請求を避けるため、AI provider で課金アラートを設定してください。
- **`--quiet` モードの使用**: 出力量は削減されますが、API 呼び出し回数は減りません。
- **適切な workflow の選択**: シンプルな workflow はマルチステージの workflow（例: 並列レビュー付きの `default`）よりも API 呼び出しが少なくなります。
- **CI トリガーの制限**: 意図しない実行を防ぐため、条件付きトリガー（例: `if: contains(github.event.comment.body, '@takt')`）を使用してください。
- **`--provider mock` でのテスト**: CI パイプラインの開発中は mock provider を使用して、実際の API コストを回避してください。
