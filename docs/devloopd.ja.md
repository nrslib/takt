# devloopd

[English](./devloopd.md)

`devloopd` は TAKT に同梱される sidecar CLI です。TAKT をサブスク/ログイン済み CLI provider だけで運用するチーム向けに、ローカル環境チェックと有限の supervisor utility を提供します。

## Doctor

長い workflow 実行や CI 的なローカル自動化の前に実行します。

```bash
devloopd doctor --subscription-only
```

すべての必須チェックが通れば終了コード `0`、subscription-only の必須ガードに違反すれば終了コード `1` で終了します。

### チェック内容

`devloopd doctor --subscription-only` は次を確認します。

- `--subscription-only` が明示されていること
- 任意の devloop policy YAML が `mode: subscription_only` であること
- `OPENAI_API_KEY` や `TAKT_OPENAI_API_KEY` のような API key 課金系の環境変数が存在しないこと
- 必須 CLI が `PATH` 上にあること: `takt`, `gh`, `codex`, `opencode`, `agy`
- Cursor CLI が `cursor-agent` または `agent` として利用できること
- `--skip-auth` を付けない限り、`gh auth status` が成功すること
- 解決後の TAKT 設定で `subscription_only: true` が有効であること
- global / project の TAKT config に API key config キーが含まれていないこと
- `.takt/workflows/` 配下の project workflow が TAKT workflow doctor に通り、subscription-only provider チェックにも通ること

doctor は禁止された環境変数名と config キー名だけを表示します。secret 値は出力しません。

### オプション

| オプション | 説明 |
|-----------|------|
| `--subscription-only` | TAKT の subscription-only policy チェックを必須にします |
| `--repo <path>` | 検査するリポジトリパス。省略時はカレントディレクトリ |
| `--policy <path>` | 任意の devloop policy YAML パス |
| `--verbose` | warning / failure だけでなく pass したチェックも表示します |
| `--skip-auth` | `gh auth status` をスキップします |

### 任意の policy ファイル

project 側に devloop policy を置く場合は `--policy` を使います。

```yaml
mode: subscription_only
```

実行例:

```bash
devloopd doctor --subscription-only --policy .takt/devloopd.yaml
```

policy ファイルを指定しない場合、doctor は warning を出して続行します。TAKT config と workflow の検査はそのまま実行されます。

## Run

`devloopd run` は、subscription-only doctor が通った場合だけ TAKT の Issue pipeline を開始します。

```bash
devloopd run --issue 123 --repo owner/repo
```

このコマンドは `devloopd doctor --subscription-only` と同じチェックを実行します。必須ガードに違反した場合、TAKT は起動しません。

チェックが通ると、`devloopd run` は次と同等の argv で TAKT を実行します。

```bash
takt --pipeline \
  --issue 123 \
  --workflow .takt/workflows/subscription-devloop.yaml \
  --auto-pr \
  --quiet \
  --repo owner/repo
```

### Run オプション

| オプション | 説明 |
|-----------|------|
| `--issue <number>` | TAKT で実行する GitHub Issue 番号 |
| `--repo <owner/repo>` | TAKT の PR 操作用リポジトリ |
| `--workflow <path>` | TAKT workflow 名またはパス。デフォルトは `.takt/workflows/subscription-devloop.yaml` |
| `--policy <path>` | doctor に渡す任意の devloop policy YAML パス |
| `--cwd <path>` | 実行対象リポジトリパス。省略時はカレントディレクトリ |
| `--skip-auth` | `gh auth status` をスキップします |
| `--no-auto-pr` | TAKT に `--auto-pr` を渡しません |
| `--no-quiet` | TAKT に `--quiet` を渡しません |

## Import And Timeline

TAKT は workflow engine として `.takt/runs/` に run metadata を出力します。`devloopd import-takt-run` はその metadata を `.devloop/ledger.jsonl` に取り込み、log / report file の artifact path、byte size、SHA-256 hash を保存します。

```bash
devloopd import-takt-run --latest --issue 123
devloopd timeline --issue 123
devloopd memory --write
```

JSONL ledger は portable な MVP event log です。`.devloop/` は Git から無視され、将来の SQLite backend に移しても TAKT run output 側を変えずに済む境界です。

`devloopd memory` は imported run metadata から compact project memory snapshot を生成します。raw log content は読みません。追跡用に report artifact path は含めますが、memory text には log artifact を含めません。

### Import オプション

| オプション | 説明 |
|-----------|------|
| `--latest` | `.takt/runs/` から最新 TAKT run を取り込みます |
| `--run <slug>` | 指定した TAKT run slug を取り込みます |
| `--issue <number>` | 取り込む run に GitHub Issue 番号を関連付けます |
| `--cwd <path>` | 検査するリポジトリパス。省略時はカレントディレクトリ |
| `--ledger <path>` | ledger パス。デフォルトは `.devloop/ledger.jsonl` |

### Timeline オプション

| オプション | 説明 |
|-----------|------|
| `--issue <number>` | GitHub Issue 番号で imported run を絞り込みます |
| `--run <slug>` | TAKT run slug で imported run を絞り込みます |
| `--cwd <path>` | 検査するリポジトリパス。省略時はカレントディレクトリ |
| `--ledger <path>` | ledger パス。デフォルトは `.devloop/ledger.jsonl` |

### Memory オプション

| オプション | 説明 |
|-----------|------|
| `--issue <number>` | GitHub Issue 番号で imported run を絞り込みます |
| `--limit <count>` | 含める imported run の最大数。デフォルトは 20 |
| `--cwd <path>` | 検査するリポジトリパス。省略時はカレントディレクトリ |
| `--ledger <path>` | ledger パス。デフォルトは `.devloop/ledger.jsonl` |
| `--output <path>` | project 内の memory 出力パス。デフォルトは `.devloop/memory.md` |
| `--write` | 表示だけでなく memory file を書き出します |

## Merge Gate

`devloopd merge-if-safe` は機械的な merge 実行者です。LLM output だけで PR を merge しません。このコマンドは `gh pr view` で PR metadata、`gh pr diff --name-only` で変更ファイル、`gh pr checks --watch` で GitHub checks を確認し、通過した場合だけ auto-merge を有効化します。

```bash
devloopd merge-if-safe --pr 456 --expected-head <sha>
```

すべての gate が通ると、devloopd は次を実行します。

```bash
gh pr merge 456 --auto --squash --delete-branch --match-head-commit <head-sha>
```

MVP gate は次の場合、merge 前に拒否または停止します。

- 必須 label `agent:auto-merge` がない
- PR が draft
- GitHub checks が通っていない
- review decision が `APPROVED` ではない
- `--expected-head` が現在の PR head SHA と一致しない
- `.github/**`, `infra/**`, `terraform/**`, `migrations/**`, `auth/**`, `billing/**`, `payments/**`, `.env*`, `*secret*`, `*credential*` のような forbidden path に触れている
- lockfile, `Dockerfile`, `src/middleware*`, `src/routes*`, `src/config*` のような human-review path に触れている
- diff がデフォルト policy の 12 files または 500 changed lines を超える

### Merge オプション

| オプション | 説明 |
|-----------|------|
| `--pr <number-or-url>` | Pull Request 番号または URL |
| `--repo <owner/repo>` | GitHub リポジトリ |
| `--expected-head <sha>` | 期待する PR head SHA。現在の head と異なる場合は merge を拒否します |
| `--cwd <path>` | `gh` を実行するリポジトリパス |

## Issue Scanner

`devloopd scan-issues` は daemon mode のための機械的 backlog scanner です。`gh issue list` を呼び、Issue metadata を正規化し、LLM selector に渡す前に候補を分類します。

```bash
devloopd scan-issues --repo owner/repo
```

Issue body と comments は untrusted input です。scanner はそれらを requirements / logs として扱い、指示としては扱いません。Issue text が secret、credential access、CI bypass、admin merge、force push、危険な shell command を要求している場合、自動候補にはせず `human_required` に分類します。

`gh issue list` が GitHub API rate limit または secondary rate limit を返した場合、`scan-issues` は `rate_limited` として失敗し、parse できた retry-after hint を表示します。rate-limited scan の後に supervisor が TAKT を起動することはありません。

デフォルトの候補分類:

- `agent:ready`, `bug`, `tests`, `docs` label がある Issue は機械的検討対象になる
- `human-required`, `security-sensitive`, `blocked`, `do-not-touch`, `billing`, `payments`, `infra` のような forbidden label がある Issue は skip する
- `docs` や `tests` のような低リスク label は `auto_merge_candidate` になり得る
- その他の eligible Issue は `auto_pr_only` になる。merge には引き続き `devloopd merge-if-safe` が必要

### Scan オプション

| オプション | 説明 |
|-----------|------|
| `--repo <owner/repo>` | GitHub リポジトリ |
| `--cwd <path>` | `gh issue list` を実行するリポジトリパス |

## Start

`devloopd active-runs` は `.takt/runs/*/meta.json` を検査し、現在実行中の TAKT run と、metadata の最終更新時刻に基づく stale state を表示します。

```bash
devloopd active-runs
```

`devloopd start --once` は MVP supervisor path をつなぎます。active run を検査し、open Issue を scan し、機械的に最も安全な候補を選び、その Issue で TAKT を実行し、最後に最新 TAKT run を devloop ledger に取り込みます。

```bash
devloopd start --repo owner/repo --once
```

長時間 daemon mode はまだ有効化していません。`--once` がない場合、`devloopd start` は scan や TAKT 起動の前に終了します。run scheduler と retry policy の hardening が済むまでは supervisor を有限に保つためです。

この有限 cycle は下位コマンドと同じ安全境界を使います。

- `active-runs` が active run 上限に達している場合、新しい作業を開始しない
- `scan-issues` が先に機械的 filter を実行する
- `auto_pr_only` Issue より `auto_merge_candidate` Issue を優先する
- `run` は TAKT 起動前に subscription-only doctor を実行する
- TAKT が成功した後に `import-takt-run --latest` で run evidence を保存する

### Active Runs オプション

| オプション | 説明 |
|-----------|------|
| `--cwd <path>` | 検査するリポジトリパス。省略時はカレントディレクトリ |
| `--stale-after-minutes <count>` | metadata 更新がない run を stale とみなすまでの分数。デフォルトは 180 |

### Start オプション

| オプション | 説明 |
|-----------|------|
| `--repo <owner/repo>` | GitHub リポジトリ |
| `--once` | scan/run/import cycle を 1 回だけ実行します。長時間 daemon mode が実装されるまでは必須です |
| `--workflow <path>` | TAKT workflow 名またはパス。デフォルトは `.takt/workflows/subscription-devloop.yaml` |
| `--policy <path>` | subscription-only doctor に渡す任意の devloop policy YAML パス |
| `--cwd <path>` | 実行対象リポジトリパス。省略時はカレントディレクトリ |
| `--ledger <path>` | ledger パス。デフォルトは `.devloop/ledger.jsonl` |
| `--max-active-runs <count>` | scan を拒否する active TAKT run 数の上限。デフォルトは 1 |
| `--stale-after-minutes <count>` | active-runs が run を stale とみなすまでの分数。デフォルトは 180 |
| `--skip-auth` | `gh auth status` をスキップします |
| `--no-auto-pr` | TAKT に `--auto-pr` を渡しません |
| `--no-quiet` | TAKT に `--quiet` を渡しません |

## Subscription-Only TAKT Config

global または project config では CLI-only provider を使います。

```yaml
subscription_only: true
provider: codex-cli
allowed_providers: [codex-cli, cursor-cli, opencode-cli, agy-cli]
```

`subscription_only: true` が有効な場合、TAKT は `codex` や `opencode` のような SDK/API provider、`openai_api_key` のような API key 設定、allowlist 外の workflow step provider 上書き、allowlist 外の実行時 `--provider` 上書きを拒否します。
