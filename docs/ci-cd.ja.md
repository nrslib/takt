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

`--pipeline` を指定すると、非インタラクティブな pipeline モードが有効になります。ブランチの作成、piece の実行、コミット、プッシュを自動的に行います。このモードは人的操作が不可能な CI/CD 自動化向けに設計されています。

Pipeline モードでは、`--auto-pr` を明示的に指定しない限り PR は作成**されません**。

### Pipeline の全オプション

| オプション | 説明 |
|-----------|------|
| `--pipeline` | **pipeline（非インタラクティブ）モードを有効化** -- CI/自動化に必要 |
| `-t, --task <text>` | タスク内容（GitHub Issue の代替） |
| `-i, --issue <N>` | GitHub Issue 番号（インタラクティブモードでの `#N` と同等） |
| `-w, --piece <name or path>` | Piece 名または piece YAML ファイルのパス |
| `-b, --branch <name>` | ブランチ名を指定（省略時は自動生成） |
| `--auto-pr` | PR を作成（インタラクティブ: 確認スキップ、pipeline: PR 有効化） |
| `--skip-git` | ブランチ作成、コミット、プッシュをスキップ（pipeline モード、piece のみ実行） |
| `--repo <owner/repo>` | リポジトリを指定（PR 作成用） |
| `-q, --quiet` | 最小出力モード: AI 出力を抑制（CI 向け） |
| `--provider <name>` | エージェント provider を上書き（claude\|codex\|opencode\|mock） |
| `--model <name>` | エージェントモデルを上書き |

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

**Piece とブランチ名を指定**

```bash
takt --pipeline --task "Fix bug" -w magi -b feat/fix-bug
```

**PR 作成用にリポジトリを指定**

```bash
takt --pipeline --task "Fix bug" --auto-pr --repo owner/repo
```

**Piece のみ実行（ブランチ作成、コミット、プッシュをスキップ）**

```bash
takt --pipeline --task "Fix bug" --skip-git
```

**最小出力モード（CI ログ向けに AI 出力を抑制）**

```bash
takt --pipeline --task "Fix bug" --quiet
```

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
| `{title}` | コミットメッセージ | Issue タイトル |
| `{issue}` | コミットメッセージ、PR 本文 | Issue 番号 |
| `{issue_body}` | PR 本文 | Issue 本文 |
| `{report}` | PR 本文 | Piece 実行レポート |

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

CI 環境での認証には、適切な API キー環境変数を設定してください。これらは他のツールとの衝突を避けるため TAKT 固有のプレフィックスを使用しています。

```bash
# Claude（Anthropic）用
export TAKT_ANTHROPIC_API_KEY=sk-ant-...

# Codex（OpenAI）用
export TAKT_OPENAI_API_KEY=sk-...

# OpenCode 用
export TAKT_OPENCODE_API_KEY=...
```

優先順位: 環境変数は `config.yaml` の設定よりも優先されます。

> **注意**: 環境変数で API キーを設定すれば、Claude Code、Codex、OpenCode CLI のインストールは不要です。TAKT が対応する API を直接呼び出します。

## コストに関する注意

TAKT は AI API（Claude または OpenAI）を使用するため、特に CI/CD 環境でタスクが自動実行される場合、大きなコストが発生する可能性があります。次の点に注意してください。

- **API 使用量の監視**: 予期しない請求を避けるため、AI provider で課金アラートを設定してください。
- **`--quiet` モードの使用**: 出力量は削減されますが、API 呼び出し回数は減りません。
- **適切な piece の選択**: シンプルな piece（例: `default-mini`）はマルチステージの piece（例: 並列レビュー付きの `default`）よりも API 呼び出しが少なくなります。
- **CI トリガーの制限**: 意図しない実行を防ぐため、条件付きトリガー（例: `if: contains(github.event.comment.body, '@takt')`）を使用してください。
- **`--provider mock` でのテスト**: CI パイプラインの開発中は mock provider を使用して、実際の API コストを回避してください。
