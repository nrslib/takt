# takt-pack.yaml 仕様書

パッケージインポート機能の誘導ファイル仕様。

## 概要

`takt-pack.yaml` は、GitHub リポジトリのルートに配置する誘導ファイルです。TAKT がリポジトリ内のパッケージコンテンツ（ファセットとピース）を見つけるために使用します。

このファイル自体はパッケージの実体ではなく、パッケージの場所を指し示す「案内板」です。

1リポジトリ = 1パッケージです。パッケージの識別子は `@{owner}/{repo}` で、リポジトリの owner と repo 名から自動的に決まります。

## ファイル名と配置

| 項目 | 値 |
|------|-----|
| ファイル名 | `takt-pack.yaml` |
| 配置場所 | リポジトリルート（固定） |
| 探索ルール | TAKT はルートのみ参照。走査しない |

## スキーマ

```yaml
# takt-pack.yaml
description: string              # 任意。パッケージの説明
path: string                     # 任意。デフォルト "."。パッケージルートへの相対パス
takt:
  min_version: string            # 任意。SemVer 準拠（例: "0.5.0"）
```

### フィールド詳細

#### path

パッケージの実体がある場所を、`takt-pack.yaml` からの相対パスで指定します。

制約:
- 相対パスのみ（`/` や `~` で始まる絶対パスは不可）
- `..` によるリポジトリ外への参照は不可

省略時は `.`（リポジトリルート）がデフォルトです。

パスが指す先のディレクトリは、次の標準構造を持つことが期待されます。

```
{path}/
  facets/                       # ファセット（部品ライブラリ）
    personas/                    # WHO: ペルソナプロンプト
    policies/                    # HOW: 判断基準・ポリシー
    knowledge/                   # WHAT TO KNOW: ドメイン知識
    instructions/                # WHAT TO DO: ステップ手順
    output-contracts/            # 出力契約テンプレート
  pieces/                        # ピース（ワークフロー定義）
```

`facets/` と `pieces/` の両方が存在する必要はありません。ファセットのみ、ピースのみのパッケージも有効です。ただし、どちらも存在しない場合はエラーとなります（空パッケージは許容しません）。

#### takt.min_version

パッケージが必要とする TAKT の最小バージョンです。SemVer（Semantic Versioning 2.0.0）準拠のバージョン文字列を指定します。

フォーマット: `{major}.{minor}.{patch}` （例: `0.5.0`, `1.0.0`）

比較ルール:
- `major` → `minor` → `patch` の順に数値として比較します（文字列比較ではありません）
- pre-release サフィックス（`-alpha`, `-beta.1` 等）は非サポートです。指定された場合はバリデーションエラーとなります
- 不正な形式（数値以外、セグメント不足等）もバリデーションエラーです

検証パターン: `/^\d+\.\d+\.\d+$/`

## パッケージの標準ディレクトリ構造

`path` が指す先は次の構造を取ります。

```
{package-root}/
  facets/                       # ファセット群
    personas/
      expert-coder.md
      security-reviewer.md
    policies/
      strict-review.md
    knowledge/
      architecture-patterns.md
    instructions/
      review-checklist.md
    output-contracts/
      review-report.md
  pieces/                        # ピース群
    expert.yaml
    security-review.yaml
```

## パッケージの識別

パッケージはリポジトリの `{owner}/{repo}` で一意に識別されます。

```
takt ensemble add github:nrslib/takt-fullstack
→ パッケージ識別子: @nrslib/takt-fullstack
→ インポート先: ~/.takt/ensemble/@nrslib/takt-fullstack/
```

`takt-pack.yaml` に `name` フィールドはありません。リポジトリ名がパッケージ名です。

## ensemble コマンド

パッケージの取り込み・削除・一覧を `takt ensemble` サブコマンドで管理します。

### takt ensemble add

パッケージを取り込みます。

```bash
takt ensemble add github:{owner}/{repo}
takt ensemble add github:{owner}/{repo}@{tag}       # タグ指定
takt ensemble add github:{owner}/{repo}@{commit-sha} # コミットSHA指定
```

タグやコミットSHAを `@` で指定することで、特定のバージョンを固定して取り込めます。省略時はデフォルトブランチの最新を取得します。

内部的には GitHub の tarball API（`GET /repos/{owner}/{repo}/tarball/{ref}`）でアーカイブをダウンロードし、Node.js の tar ライブラリで `.md` / `.yaml` / `.yml` ファイルのみを展開します。`git clone` は使用しません。

```
1. gh api repos/{owner}/{repo}/tarball/{ref} → /tmp/takt-import-xxxxx.tar.gz
2. tar 展開（filter: .md/.yaml/.yml のみ、lstat でシンボリックリンクをスキップ）→ /tmp/takt-import-xxxxx/
3. takt-pack.yaml を読み取り → path 確定、バリデーション
4. {path}/facets/ と {path}/pieces/ を ~/.takt/ensemble/@{owner}/{repo}/ にコピー
5. .takt-pack-lock.yaml を生成
6. rm -rf /tmp/takt-import-xxxxx*
```

コミット SHA は tarball の展開ディレクトリ名（`{owner}-{repo}-{sha}/`）から取得します。ref 省略時はデフォルトブランチの HEAD SHA が含まれます。

取り込み後、`.takt-pack-lock.yaml` を自動生成し、取り込み元の情報を記録します。

```yaml
# .takt-pack-lock.yaml（自動生成、編集不要）
source: github:nrslib/takt-fullstack
ref: v1.2.0              # 指定されたタグ or SHA（省略時は "HEAD"）
commit: abc1234def5678    # 実際にチェックアウトされたコミットSHA
imported_at: 2026-02-20T12:00:00Z
```

`takt ensemble list` はこの情報も表示します。

インポート先:
```
~/.takt/ensemble/@{owner}/{repo}/
  takt-pack.yaml                 # 元の誘導ファイル（メタデータ参照用に保持）
  .takt-pack-lock.yaml           # 取り込み元情報（自動生成）
  facets/
  pieces/
```

インストール前に、パッケージの内容サマリーを表示してユーザーの確認を求めます。

```
takt ensemble add github:nrslib/takt-fullstack@v1.2.0

📦 nrslib/takt-fullstack @v1.2.0
   faceted: 2 personas, 2 policies, 1 knowledge
   pieces:  2 (expert, expert-mini)

   ⚠ expert.yaml: edit: true, allowed_tools: [Bash, Write, Edit]
   ⚠ expert-mini.yaml: edit: true

インストールしますか？ [y/N]
```

サマリーには次の情報を含めます。

| 項目 | 内容 |
|------|------|
| パッケージ情報 | owner/repo、ref |
| ファセット数 | facets/ の種別ごとのファイル数 |
| ピース一覧 | pieces/ 内のピース名 |
| 権限警告 | 各ピースの `edit`、`allowed_tools`、`required_permission_mode` を表示 |

権限警告はピースの YAML をパースし、エージェントに付与される権限をユーザーが判断できるようにします。`edit: true` や `allowed_tools` に `Bash` を含むピースは `⚠` 付きで強調表示します。

`takt-pack.yaml` が見つからない場合、`gh` CLI 未インストール、ネットワークエラー等はすべてエラー終了します（fail-fast）。

### takt ensemble remove

インストール済みパッケージを削除します。

```bash
takt ensemble remove @{owner}/{repo}
```

削除前に参照整合性チェックを行い、壊れる可能性のある参照を警告します。

```
参照チェック中...

⚠ 次のファイルが @nrslib/takt-fullstack を参照しています:
  ~/.takt/pieces/my-review.yaml (persona: "@nrslib/takt-fullstack/expert-coder")
  ~/.takt/preferences/piece-categories.yaml → @nrslib/takt-fullstack/expert を含む

パッケージ @nrslib/takt-fullstack を削除しますか？ [y/N]

y → rm -rf ~/.takt/ensemble/@{owner}/{repo}/
  → @{owner}/ 配下に他のパッケージがなければ @{owner}/ ディレクトリも削除
N → 中断
```

参照検出スキャン対象:
- `~/.takt/pieces/**/*.yaml` — `@scope` を含むファセット参照
- `~/.takt/preferences/piece-categories.yaml` — `@scope` ピース名を含むカテゴリ定義
- `.takt/pieces/**/*.yaml` — プロジェクトレベルのピースファセット参照

参照が見つかった場合も削除は実行可能です（警告のみ、ブロックしない）。自動クリーンアップは行いません（ユーザーが意図的に参照を残している可能性があるため）。

### takt ensemble list

インストール済みパッケージの一覧を表示します。

```bash
takt ensemble list
```

```
📦 インストール済みパッケージ:
  @nrslib/takt-fullstack       フルスタック開発ワークフロー          (v1.2.0 abc1234)
  @nrslib/takt-security-facets セキュリティレビュー用ファセット集    (HEAD def5678)
  @acme-corp/takt-backend      Backend (Kotlin/CQRS+ES) facets       (v2.0.0 789abcd)
```

`~/.takt/ensemble/` 配下をスキャンし、各パッケージの `takt-pack.yaml` から `description` を、`.takt-pack-lock.yaml` から `ref` と `commit`（先頭7文字）を読み取って表示します。

## 利用シナリオ

---

### シナリオ 1: ファセットライブラリの公開と取り込み

ユーザー nrslib が、セキュリティレビュー用のファセットを公開します。

#### 公開側のリポジトリ構造

```
github:nrslib/takt-security-facets
├── takt-pack.yaml
└── facets/
    ├── personas/
    │   └── security-reviewer.md
    ├── policies/
    │   └── owasp-checklist.md
    └── knowledge/
        └── vulnerability-patterns.md
```

```yaml
# takt-pack.yaml
description: セキュリティレビュー用ファセット集
```

`path` 省略のため、デフォルト `.`（リポジトリルート）を参照します。

#### 取り込み側の操作

```bash
takt ensemble add github:nrslib/takt-security-facets
```

#### ファイルの動き

```
1. gh api repos/nrslib/takt-security-facets/tarball → /tmp/takt-import-xxxxx.tar.gz

2. tar 展開（.md/.yaml/.yml のみ、lstat で symlink スキップ）→ /tmp/takt-import-xxxxx/
   展開ディレクトリ名 nrslib-takt-security-facets-{sha}/ からコミット SHA を取得

3. takt-pack.yaml を読み取り → path: "."

4. コピー元ベース: /tmp/takt-import-xxxxx/
   コピー先:       ~/.takt/ensemble/@nrslib/takt-security-facets/

5. コピーされるファイル:
   /tmp/.../takt-pack.yaml         → ~/.takt/ensemble/@nrslib/takt-security-facets/takt-pack.yaml
   /tmp/.../facets/personas/...   → ~/.takt/ensemble/@nrslib/takt-security-facets/facets/personas/...
   /tmp/.../facets/policies/...   → ~/.takt/ensemble/@nrslib/takt-security-facets/facets/policies/...
   /tmp/.../facets/knowledge/...  → ~/.takt/ensemble/@nrslib/takt-security-facets/facets/knowledge/...

   ※ facets/, pieces/ のみスキャン。それ以外のディレクトリは無視

6. .takt-pack-lock.yaml を生成

7. rm -rf /tmp/takt-import-xxxxx*
```

#### 取り込み後のローカル構造

```
~/.takt/
  ensemble/
    @nrslib/
      takt-security-facets/
        takt-pack.yaml
        .takt-pack-lock.yaml
        facets/
          personas/
            security-reviewer.md
          policies/
            owasp-checklist.md
          knowledge/
            vulnerability-patterns.md
```

#### 利用方法

自分のピースから `@scope` 付きで参照します。

```yaml
# ~/.takt/pieces/my-review.yaml
name: my-review
movements:
  - name: security-check
    persona: "@nrslib/takt-security-facets/security-reviewer"
    policy: "@nrslib/takt-security-facets/owasp-checklist"
    knowledge: "@nrslib/takt-security-facets/vulnerability-patterns"
    instruction: review-security
    # ...
```

---

### シナリオ 2: ピース付きパッケージの公開と取り込み

ユーザー nrslib が、ファセットとピースをセットで公開します。

#### 公開側のリポジトリ構造

```
github:nrslib/takt-fullstack
├── takt-pack.yaml
├── facets/
│   ├── personas/
│   │   ├── expert-coder.md
│   │   └── architecture-reviewer.md
│   ├── policies/
│   │   ├── strict-coding.md
│   │   └── strict-review.md
│   └── knowledge/
│       └── design-patterns.md
└── pieces/
    ├── expert.yaml
    └── expert-mini.yaml
```

```yaml
# takt-pack.yaml
description: フルスタック開発ワークフロー（ファセット + ピース）
```

`expert.yaml` 内では、同パッケージのファセットを名前ベースで参照しています。

```yaml
# pieces/expert.yaml
name: expert
movements:
  - name: implement
    persona: expert-coder           # → facets/personas/expert-coder.md
    policy: strict-coding           # → facets/policies/strict-coding.md
    knowledge: design-patterns      # → facets/knowledge/design-patterns.md
    # ...
  - name: review
    persona: architecture-reviewer
    policy: strict-review
    # ...
```

#### 取り込み側の操作

```bash
takt ensemble add github:nrslib/takt-fullstack
```

#### ファイルの動き

```
1. gh api repos/nrslib/takt-fullstack/tarball → /tmp/takt-import-xxxxx.tar.gz

2. tar 展開（.md/.yaml/.yml のみ、lstat で symlink スキップ）→ /tmp/takt-import-xxxxx/
   展開ディレクトリ名からコミット SHA を取得

3. takt-pack.yaml 読み取り → path: "."

4. コピーされるファイル:
   /tmp/.../takt-pack.yaml              → ~/.takt/ensemble/@nrslib/takt-fullstack/takt-pack.yaml
   /tmp/.../facets/personas/...        → ~/.takt/ensemble/@nrslib/takt-fullstack/facets/personas/...
   /tmp/.../facets/policies/...        → ~/.takt/ensemble/@nrslib/takt-fullstack/facets/policies/...
   /tmp/.../facets/knowledge/...       → ~/.takt/ensemble/@nrslib/takt-fullstack/facets/knowledge/...
   /tmp/.../pieces/expert.yaml          → ~/.takt/ensemble/@nrslib/takt-fullstack/pieces/expert.yaml
   /tmp/.../pieces/expert-mini.yaml     → ~/.takt/ensemble/@nrslib/takt-fullstack/pieces/expert-mini.yaml

   ※ facets/, pieces/ のみスキャン。それ以外のディレクトリは無視

5. .takt-pack-lock.yaml を生成

6. rm -rf /tmp/takt-import-xxxxx*
```

#### 取り込み後のローカル構造

```
~/.takt/
  ensemble/
    @nrslib/
      takt-fullstack/
        takt-pack.yaml
        .takt-pack-lock.yaml
        facets/
          personas/
            expert-coder.md
            architecture-reviewer.md
          policies/
            strict-coding.md
            strict-review.md
          knowledge/
            design-patterns.md
        pieces/
          expert.yaml
          expert-mini.yaml
```

#### 利用方法

**A. インポートしたピースをそのまま使う**

```bash
takt -w @nrslib/takt-fullstack/expert "認証機能を実装して"
```

ピースの `pieceDir` は `~/.takt/ensemble/@nrslib/takt-fullstack/pieces/` になります。
ピース内の名前ベース参照（`persona: expert-coder`）は、パッケージローカルの `facets/` から解決されます。

解決チェーン:
```
1. package-local: ~/.takt/ensemble/@nrslib/takt-fullstack/facets/personas/expert-coder.md  ← HIT
2. project:       .takt/facets/personas/expert-coder.md
3. user:          ~/.takt/facets/personas/expert-coder.md
4. builtin:       builtins/{lang}/facets/personas/expert-coder.md
```

**B. ファセットだけ自分のピースで使う**

```yaml
# ~/.takt/pieces/my-workflow.yaml
movements:
  - name: implement
    persona: "@nrslib/takt-fullstack/expert-coder"     # パッケージのファセットを参照
    policy: coding                                     # 自分のファセットを参照
```

---

### シナリオ 3: パッケージが別ディレクトリにある場合

リポジトリの一部だけが TAKT パッケージで、他のコンテンツも含まれるリポジトリです。

#### 公開側のリポジトリ構造

```
github:someone/dotfiles
├── takt-pack.yaml
├── vim/
│   └── .vimrc
├── zsh/
│   └── .zshrc
└── takt/                        # ← TAKT パッケージはここだけ
    ├── facets/
    │   └── personas/
    │       └── my-coder.md
    └── pieces/
        └── my-workflow.yaml
```

```yaml
# takt-pack.yaml
description: My personal TAKT setup
path: takt
```

`path: takt` により、`takt/` ディレクトリ以下だけがパッケージとして認識されます。

#### 取り込み側の操作

```bash
takt ensemble add github:someone/dotfiles
```

#### ファイルの動き

```
1. gh api repos/someone/dotfiles/tarball → /tmp/takt-import-xxxxx.tar.gz

2. tar 展開（.md/.yaml/.yml のみ、lstat で symlink スキップ）→ /tmp/takt-import-xxxxx/
   展開ディレクトリ名からコミット SHA を取得

3. takt-pack.yaml 読み取り → path: "takt"

4. コピー元ベース: /tmp/takt-import-xxxxx/takt/
   コピー先:       ~/.takt/ensemble/@someone/dotfiles/

5. コピーされるファイル:
   /tmp/.../takt-pack.yaml                     → ~/.takt/ensemble/@someone/dotfiles/takt-pack.yaml
   /tmp/.../takt/facets/personas/my-coder.md  → ~/.takt/ensemble/@someone/dotfiles/facets/personas/my-coder.md
   /tmp/.../takt/pieces/my-workflow.yaml       → ~/.takt/ensemble/@someone/dotfiles/pieces/my-workflow.yaml

   ※ facets/, pieces/ のみスキャン。vim/, zsh/ 等は無視

6. .takt-pack-lock.yaml を生成

7. rm -rf /tmp/takt-import-xxxxx*
```

---

### シナリオ 4: 既存パッケージの上書き

同じパッケージを再度インポートした場合の動作です。

```bash
# 初回
takt ensemble add github:nrslib/takt-fullstack

# 2回目（更新版を取り込みたい）
takt ensemble add github:nrslib/takt-fullstack
```

```
インポート先: ~/.takt/ensemble/@nrslib/takt-fullstack/

⚠ パッケージ @nrslib/takt-fullstack は既にインストールされています。
  上書きしますか？ [y/N]

y → 原子的差し替え（下記参照）
N → 中断
```

上書き時は原子的更新を行い、コピー失敗時に既存パッケージを失わないようにします。

```
0. 前回の残留チェック
   if exists(takt-fullstack.tmp/) → rm -rf takt-fullstack.tmp/
   if exists(takt-fullstack.bak/) → rm -rf takt-fullstack.bak/
   # 前回の異常終了で残った一時ファイルをクリーンアップ

1. 新パッケージを一時ディレクトリに展開・検証
   → ~/.takt/ensemble/@nrslib/takt-fullstack.tmp/

2. 検証成功（takt-pack.yaml パース、空パッケージチェック等）
   失敗 → rm -rf takt-fullstack.tmp/ → エラー終了

3. 既存を退避
   rename takt-fullstack/ → takt-fullstack.bak/
   失敗 → rm -rf takt-fullstack.tmp/ → エラー終了

4. 新パッケージを配置
   rename takt-fullstack.tmp/ → takt-fullstack/
   失敗 → rename takt-fullstack.bak/ → takt-fullstack/ → エラー終了
          復元も失敗した場合 → エラーメッセージに takt-fullstack.bak/ の手動復元を案内

5. 退避を削除
   rm -rf takt-fullstack.bak/
   失敗 → 警告表示のみ（新パッケージは正常配置済み）
```

ステップ0により、前回の異常終了で `.tmp/` や `.bak/` が残っていても再実行が安全に動作します。

---

### シナリオ 5: パッケージの削除

```bash
takt ensemble remove @nrslib/takt-fullstack
```

```
参照チェック中...

⚠ 次のファイルが @nrslib/takt-fullstack を参照しています:
  ~/.takt/pieces/my-review.yaml (persona: "@nrslib/takt-fullstack/expert-coder")

パッケージ @nrslib/takt-fullstack を削除しますか？ [y/N]

y → rm -rf ~/.takt/ensemble/@nrslib/takt-fullstack/
  → @nrslib/ 配下に他のパッケージがなければ @nrslib/ ディレクトリも削除
```

参照が見つかっても削除は可能です（警告のみ）。参照先のファイルは自動修正されません。

---

## @scope 参照の解決ルール

### 名前制約

`@{owner}/{repo}/{facet-or-piece-name}` の各セグメントには次の制約があります。

| セグメント | 許可文字 | パターン | 備考 |
|-----------|---------|---------|------|
| `owner` | 英小文字、数字、ハイフン | `/^[a-z0-9][a-z0-9-]*$/` | GitHub ユーザー名を小文字正規化 |
| `repo` | 英小文字、数字、ハイフン、ドット、アンダースコア | `/^[a-z0-9][a-z0-9._-]*$/` | GitHub リポジトリ名を小文字正規化 |
| `facet-or-piece-name` | 英小文字、数字、ハイフン | `/^[a-z0-9][a-z0-9-]*$/` | 拡張子なし。ファセットは `.md`、ピースは `.yaml` が自動付与される |

すべてのセグメントは大文字小文字を区別しません（case-insensitive）。内部的には小文字に正規化して格納・比較します。

`repo` のパターンが他より広いのは、GitHub リポジトリ名にドット（`.`）やアンダースコア（`_`）が使用可能なためです。

### ファセット参照

ピース YAML 内で `@` プレフィックス付きの名前を使うと、パッケージのファセットを参照します。

```
@{owner}/{repo}/{facet-name}
```

解決先:
```
~/.takt/ensemble/@{owner}/{repo}/facets/{facet-type}/{facet-name}.md
```

`{facet-type}` はコンテキストから決まります。

| ピース YAML フィールド | facet-type |
|----------------------|------------|
| `persona` | `personas` |
| `policy` | `policies` |
| `knowledge` | `knowledge` |
| `instruction` | `instructions` |
| `output_contract` | `output-contracts` |

例:
```yaml
persona: "@nrslib/takt-fullstack/expert-coder"
# → ~/.takt/ensemble/@nrslib/takt-fullstack/facets/personas/expert-coder.md
```

### ピース参照

```bash
takt -w @{owner}/{repo}/{piece-name}
```

解決先:
```
~/.takt/ensemble/@{owner}/{repo}/pieces/{piece-name}.yaml
```

例:
```bash
takt -w @nrslib/takt-fullstack/expert "タスク内容"
# → ~/.takt/ensemble/@nrslib/takt-fullstack/pieces/expert.yaml
```

### ファセット名前解決チェーン

名前ベースのファセット参照（`persona: coder` のような @scope なしの参照）は、次の優先順位で解決されます。

パッケージ内ピースの場合:
```
1. package-local   ~/.takt/ensemble/@{owner}/{repo}/facets/{type}/{facet}.md
2. project         .takt/facets/{type}/{facet}.md
3. user            ~/.takt/facets/{type}/{facet}.md
4. builtin         builtins/{lang}/facets/{type}/{facet}.md
```

非パッケージピースの場合（ユーザー自身のピース、builtin ピース）:
```
1. project         .takt/facets/{type}/{facet}.md
2. user            ~/.takt/facets/{type}/{facet}.md
3. builtin         builtins/{lang}/facets/{type}/{facet}.md
```

パッケージのファセットはグローバル名前解決に入りません。他パッケージのファセットを使いたい場合は `@scope` 参照で明示的に指定してください。

### パッケージ所属の検出

ピースがどのパッケージに属するかは、`pieceDir`（ピースファイルの親ディレクトリ）のパスから判定します。

```
pieceDir が ~/.takt/ensemble/@{owner}/{repo}/pieces/ 配下
  → パッケージ @{owner}/{repo} に所属
  → package-local 解決チェーンが有効化
  → candidateDirs の先頭に ~/.takt/ensemble/@{owner}/{repo}/facets/{type}/ を追加
```

`~/.takt/ensemble/` 配下でなければパッケージ所属なし（既存の3層解決チェーンのまま）。

## バリデーションルール

| ルール | エラー時の動作 |
|-------|-------------|
| `takt-pack.yaml` がリポジトリルートに存在しない | エラー終了。メッセージ表示 |
| `path` が絶対パスまたは `..` でリポジトリ外を参照 | エラー終了 |
| `path` が指すディレクトリが存在しない | エラー終了 |
| `path` 先に `facets/` も `pieces/` もない | エラー終了（空パッケージは不許可） |
| `takt.min_version` が SemVer 形式でない | エラー終了。`{major}.{minor}.{patch}` 形式を要求 |
| `takt.min_version` が現在の TAKT より新しい | エラー終了。必要バージョンと現在バージョンを表示 |

## セキュリティ

### コピー対象ディレクトリの制限

`{path}/` 直下の `facets/` と `pieces/` のみをスキャンします。それ以外のディレクトリ（README、テスト、CI設定等）は無視されます。`takt-pack.yaml` はリポジトリルートから常にコピーします。

```
コピー対象:
  {path}/facets/**    → ~/.takt/ensemble/@{owner}/{repo}/facets/
  {path}/pieces/**     → ~/.takt/ensemble/@{owner}/{repo}/pieces/
  takt-pack.yaml       → ~/.takt/ensemble/@{owner}/{repo}/takt-pack.yaml

無視:
  {path}/README.md
  {path}/tests/
  {path}/.github/
  その他すべて
```

### コピー対象ファイルの制限

上記ディレクトリ内でも、コピーするファイルは `.md`、`.yaml`、`.yml` のみに限定します。それ以外のファイルはすべて無視します。

| 拡張子 | コピー | 用途 |
|-------|--------|------|
| `.md` | する | ファセット（ペルソナ、ポリシー、ナレッジ、インストラクション、出力契約） |
| `.yaml` / `.yml` | する | ピース定義、takt-pack.yaml |
| その他すべて | しない | スクリプト、バイナリ、dotfile 等 |

これにより、悪意のあるリポジトリから実行可能ファイルやスクリプトがコピーされることを防ぎます。

tar 展開時のフィルタ処理（擬似コード）:
```
ALLOWED_EXTENSIONS = ['.md', '.yaml', '.yml']

tar.extract({
  file: archivePath,
  cwd: tempDir,
  strip: 1,
  filter: (path, entry) => {
    if entry.type === 'SymbolicLink' → skip
    if extension(path) not in ALLOWED_EXTENSIONS → skip
    return true
  }
})
```

展開後のコピー処理:
```
ALLOWED_DIRS = ['facets', 'pieces']

for each dir in ALLOWED_DIRS:
  if not exists(join(packageRoot, dir)) → skip
  for each file in walk(join(packageRoot, dir)):
    if lstat(file).isSymbolicLink() → skip   # defence-in-depth
    if file.size > MAX_FILE_SIZE → skip
    copy to destination
    increment file count
    if file count > MAX_FILE_COUNT → error
```

`takt-pack.yaml` はリポジトリルートから常にコピーします（`.yaml` なので展開フィルタも通過します）。

シンボリックリンクは tar 展開時の `filter` で除外します。加えて defence-in-depth としてコピー走査時にも `lstat` でスキップします。

### その他のセキュリティ考慮事項

| 脅威 | 対策 |
|------|------|
| シンボリックリンクによるリポジトリ外へのアクセス | 主対策: tar 展開時の `filter` で `SymbolicLink` エントリを除外。副対策: コピー走査時に `lstat` でスキップ |
| パストラバーサル（`path: ../../etc`） | `..` を含むパスを拒否。加えて `realpath` 正規化後にリポジトリルート配下であることを検証 |
| 巨大ファイルによるディスク枯渇 | 単一ファイルサイズ上限（例: 1MB）を設ける |
| 大量ファイルによるディスク枯渇 | パッケージあたりのファイル数上限（例: 500）を設ける |

### パス検証の実装指針

`path` フィールドおよびコピー対象ファイルのパス検証は、次の順序で行います。

```
1. tarball ダウンロード
   gh api repos/{owner}/{repo}/tarball/{ref} → archive.tar.gz

2. tar 展開（フィルタ付き）
   - entry.type === 'SymbolicLink' → skip
   - extension not in ['.md', '.yaml', '.yml'] → skip
   → tempDir/ に展開

3. path フィールドの文字列検証
   - 絶対パス（/ or ~）→ エラー
   - ".." セグメントを含む → エラー

4. realpath 正規化
   extractRoot = realpath(tempDir)
   packageRoot = realpath(join(tempDir, path))
   if packageRoot !== extractRoot
     && !packageRoot.startsWith(extractRoot + '/') → エラー
   # 末尾に '/' を付けて比較することで /tmp/repo と /tmp/repo2 の誤判定を防ぐ

5. コピー走査時（facets/, pieces/ 配下）
   for each file:
     if lstat(file).isSymbolicLink() → skip   # defence-in-depth
     if file.size > MAX_FILE_SIZE → skip
     copy to destination
```

### 信頼モデル

本仕様ではパッケージの信頼性検証（署名検証、allowlist 等）を定義しません。現時点では「ユーザーが信頼するリポジトリを自己責任で指定する」という前提です。インストール前のサマリー表示（権限警告を含む）がユーザーの判断材料になります。

信頼モデルの高度な仕組み（パッケージ署名、レジストリ、信頼済みパブリッシャーリスト等）は、エコシステムの成熟に応じて別仕様で定義する予定です。

## ピースカテゴリとの統合

### デフォルト動作

インポートしたパッケージに含まれるピースは、「ensemble」カテゴリに自動配置されます。「その他」カテゴリと同じ仕組みで、どのカテゴリにも属さないインポート済みピースがここに集約されます。

```
takt switch

? ピースを選択:
  🚀 クイックスタート
    default-mini
    frontend-mini
    ...
  🔧 エキスパート
    expert
    expert-mini
    ...
  📦 ensemble                              ← インポートしたピースの自動カテゴリ
    @nrslib/takt-fullstack/expert
    @nrslib/takt-fullstack/expert-mini
    @acme-corp/takt-backend/backend-review
  その他
    ...
```

ピースを含まないパッケージ（ファセットライブラリ）はカテゴリに表示されません。

### ピース名の形式

インポートしたピースは `@{owner}/{repo}/{piece-name}` の形式でカテゴリに登録されます。

| ピースの種類 | カテゴリ内での名前 |
|-------------|------------------|
| ユーザー自身のピース | `expert` |
| builtin ピース | `default` |
| インポートしたピース | `@nrslib/takt-fullstack/expert` |

### 影響を受けるコード

| ファイル | 変更内容 |
|---------|---------|
| `src/infra/config/loaders/pieceResolver.ts` | `loadAllPiecesWithSources()` がパッケージ層もスキャンするよう拡張 |
| `src/infra/config/loaders/pieceCategories.ts` | `ensemble` カテゴリの自動生成ロジック追加（`appendOthersCategory` と同様の仕組み） |
| `src/features/pieceSelection/` | `@scope` 付きピース名の表示・選択対応 |

## builtin の構造変更

この機能の導入に伴い、builtin ディレクトリ構造を `facets/` + `pieces/` の2層構造に改修します。

### 変更前（現行構造）

```
builtins/{lang}/
  personas/                      # ← ルート直下にファセット種別ごとのディレクトリ
    coder.md
    planner.md
    ...
  policies/
    coding.md
    review.md
    ...
  knowledge/
    architecture.md
    backend.md
    ...
  instructions/
    plan.md
    implement.md
    ...
  output-contracts/
    plan.md
    ...
  pieces/
    default.yaml
    expert.yaml
    ...
  templates/
    ...
  config.yaml
  piece-categories.yaml
  STYLE_GUIDE.md
  PERSONA_STYLE_GUIDE.md
  ...
```

### 変更後

```
builtins/{lang}/
  facets/                       # ← ファセットを facets/ 配下に集約
    personas/
      coder.md
      planner.md
      ...
    policies/
      coding.md
      review.md
      ...
    knowledge/
      architecture.md
      backend.md
      ...
    instructions/
      plan.md
      implement.md
      ...
    output-contracts/
      plan.md
      ...
  pieces/                        # ← ピースはそのまま（位置変更なし）
    default.yaml
    expert.yaml
    ...
  templates/                     # ← 変更なし
    ...
  config.yaml                   # ← 変更なし
  piece-categories.yaml         # ← 変更なし
  STYLE_GUIDE.md                # ← 変更なし
  ...
```

### 影響を受けるコード

| ファイル | 変更内容 |
|---------|---------|
| `src/infra/config/paths.ts` | `getBuiltinFacetDir()`, `getGlobalFacetDir()`, `getProjectFacetDir()` のパス構築に `facets/` を追加 |
| `src/infra/config/loaders/resource-resolver.ts` | `buildCandidateDirs()` が返すディレクトリパスの更新 |
| `src/features/catalog/catalogFacets.ts` | `getFacetDirs()` のパス構築の更新 |
| `src/infra/config/loaders/pieceResolver.ts` | パッケージ層の解決ロジック追加（`@scope` 対応）、`loadAllPiecesWithSources()` のパッケージスキャン |
| `src/infra/config/loaders/pieceCategories.ts` | `ensemble` カテゴリの自動生成（`appendOthersCategory` と同様の仕組み） |
| `src/features/pieceSelection/` | `@scope` 付きピース名の表示・選択対応 |
| `src/faceted-prompting/resolve.ts` | `@` プレフィックス判定とパッケージディレクトリへの解決を追加 |

### ユーザー側の移行

`~/.takt/` にファセットを配置しているユーザーは、ファイルを移動する必要があります。

```bash
# 移行例
mkdir -p ~/.takt/facets
mv ~/.takt/personas   ~/.takt/facets/personas
mv ~/.takt/policies   ~/.takt/facets/policies
mv ~/.takt/knowledge  ~/.takt/facets/knowledge
mv ~/.takt/instructions ~/.takt/facets/instructions
mv ~/.takt/output-contracts ~/.takt/facets/output-contracts
```

プロジェクトレベル（`.takt/`）も同様です。

### ピース YAML への影響

名前ベース参照（影響なし）:

```yaml
persona: coder              # リゾルバが facets/personas/coder.md を探す
policy: coding              # リゾルバが facets/policies/coding.md を探す
```

リゾルバの内部パスが変わるだけで、ピース YAML の修正は不要です。

相対パス参照（修正が必要）:

```yaml
# 変更前
personas:
  coder: ../personas/coder.md

# 変更後
personas:
  coder: ../facets/personas/coder.md
```

ピースの `personas:` セクションマップで相対パスを使用している場合のみ修正が必要です。builtin のピースは名前ベース参照を使用しているため、影響を受けません。

## 全体構造（まとめ）

```
~/.takt/
  facets/                                 # ユーザー自身のファセット
    personas/
    policies/
    knowledge/
    instructions/
    output-contracts/
  pieces/                                  # ユーザー自身のピース
  ensemble/                                # インポートしたパッケージ
    @nrslib/
      takt-fullstack/
        takt-pack.yaml
        .takt-pack-lock.yaml
        facets/
          personas/
          policies/
          knowledge/
        pieces/
          expert.yaml
      takt-security-facets/
        takt-pack.yaml
        .takt-pack-lock.yaml
        facets/
          personas/
          policies/
          knowledge/

builtins/{lang}/
  facets/                                 # ビルトインファセット
    personas/
    policies/
    knowledge/
    instructions/
    output-contracts/
  pieces/                                  # ビルトインピース
  templates/
  config.yaml
  piece-categories.yaml
```

ファセット解決の全体チェーン:
```
@scope 参照   → ensemble/@{owner}/{repo}/facets/ で直接解決
名前参照      → project .takt/facets/ → user ~/.takt/facets/ → builtin facets/
pkg内名前参照 → package-local facets/ → project → user → builtin
```

## テスト戦略

### テスト用リポジトリ

`takt ensemble add` の E2E テストのため、テスト用の GitHub リポジトリを用意します。

| リポジトリ | 用途 |
|-----------|------|
| `nrslib/takt-pack-fixture` | 標準構造のテストパッケージ。faceted + pieces |
| `nrslib/takt-pack-fixture-subdir` | `path` 指定ありのテストパッケージ |
| `nrslib/takt-pack-fixture-facets-only` | ファセットのみのテストパッケージ |

テストリポジトリは特定のタグ（`v1.0.0` 等）を打ち、テスト時は `@tag` 指定で取り込むことで再現性を確保します。

```bash
# テストでの使用例
takt ensemble add github:nrslib/takt-pack-fixture@v1.0.0
```

### ユニットテスト

E2E テスト以外は、ファイルシステムのフィクスチャで検証します。

| テスト対象 | 方法 |
|-----------|------|
| takt-pack.yaml パース・バリデーション | Zod スキーマのユニットテスト |
| ファイルフィルタ（拡張子、サイズ） | tmp ディレクトリにフィクスチャを作成して検証 |
| @scope 解決 | `~/.takt/ensemble/` 相当のフィクスチャディレクトリで検証 |
| 原子的更新 | コピー途中の失敗シミュレーションで復元を検証 |
| 参照整合性チェック | @scope 参照を含むピース YAML フィクスチャで検証 |
