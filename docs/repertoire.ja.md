# Repertoire パッケージ

[English](./repertoire.md)

Repertoire パッケージを使うと、GitHub リポジトリから TAKT のピースやファセットをインストール・共有できます。

## クイックスタート

```bash
# パッケージをインストール
takt repertoire add github:nrslib/takt-fullstack

# 特定バージョンを指定してインストール
takt repertoire add github:nrslib/takt-fullstack@v1.0.0

# インストール済みパッケージを一覧表示
takt repertoire list

# パッケージを削除
takt repertoire remove @nrslib/takt-fullstack
```

[GitHub CLI](https://cli.github.com/) (`gh`) のインストールと認証が必要です。

## パッケージ構造

TAKT パッケージは `takt-repertoire.yaml` マニフェストとコンテンツディレクトリを持つ GitHub リポジトリです。

```
my-takt-repertoire/
  takt-repertoire.yaml       # マニフェスト（.takt/takt-repertoire.yaml でも可）
  facets/
    personas/
      expert-coder.md
    policies/
      strict-review.md
    knowledge/
      domain.md
    instructions/
      plan.md
  pieces/
    expert.yaml
```

`facets/` と `pieces/` ディレクトリのみがインポートされます。その他のファイルは無視されます。

### takt-repertoire.yaml

マニフェストは、リポジトリ内のパッケージコンテンツの場所を TAKT に伝えます。

```yaml
# 説明（任意）
description: フルスタック開発用ピースとエキスパートレビュアー

# パッケージルートへのパス（リポジトリルートからの相対パス、デフォルト: "."）
path: .

# TAKT バージョン制約（任意）
takt:
  min_version: 0.22.0
```

マニフェストはリポジトリルート（`takt-repertoire.yaml`）または `.takt/` 内（`.takt/takt-repertoire.yaml`）に配置できます。`.takt/` が優先的に検索されます。

| フィールド | 必須 | デフォルト | 説明 |
|-----------|------|-----------|------|
| `description` | いいえ | - | パッケージの説明 |
| `path` | いいえ | `.` | `facets/` と `pieces/` を含むディレクトリへのパス |
| `takt.min_version` | いいえ | - | 必要な TAKT の最低バージョン（X.Y.Z 形式） |

## インストール

```bash
takt repertoire add github:{owner}/{repo}@{ref}
```

`@{ref}` は省略可能です。省略した場合、リポジトリのデフォルトブランチが使用されます。

インストール前に、パッケージの内容サマリ（ファセット種別ごとの数、ピース名、edit 権限の警告）が表示され、確認を求められます。

### インストール時の処理

1. `gh api` 経由で GitHub から tarball をダウンロード
2. `facets/` と `pieces/` のファイルのみを展開（`.md`、`.yaml`、`.yml`）
3. `takt-repertoire.yaml` マニフェストをバリデーション
4. TAKT バージョン互換性チェック
5. `~/.takt/repertoire/@{owner}/{repo}/` にファイルをコピー
6. ロックファイル（`.takt-repertoire-lock.yaml`）を生成（ソース、ref、コミット SHA）

インストールはアトミックに行われます。途中で失敗しても中途半端な状態は残りません。

### セキュリティ制約

- `.md`、`.yaml`、`.yml` ファイルのみコピー
- シンボリックリンクはスキップ
- 1 MB を超えるファイルはスキップ
- 500 ファイルを超えるパッケージは拒否
- `path` フィールドのディレクトリトラバーサルを拒否
- realpath による symlink ベースのトラバーサル検出

## パッケージの使い方

### ピース

インストールされたピースはピース選択 UI の「repertoire」カテゴリにパッケージごとのサブカテゴリとして表示されます。直接指定も可能です。

```bash
takt --piece @nrslib/takt-fullstack/expert
```

### @scope 参照

インストール済みパッケージのファセットは、piece YAML で `@{owner}/{repo}/{facet-name}` 構文を使って参照できます。

```yaml
movements:
  - name: implement
    persona: @nrslib/takt-fullstack/expert-coder
    policy: @nrslib/takt-fullstack/strict-review
    knowledge: @nrslib/takt-fullstack/domain
```

### 4層ファセット解決

repertoire パッケージのピースが名前（@scope なし）でファセットを解決する場合、次の順序で検索されます。

1. **パッケージローカル**: `~/.takt/repertoire/@{owner}/{repo}/facets/{type}/`
2. **プロジェクト**: `.takt/facets/{type}/`
3. **ユーザー**: `~/.takt/facets/{type}/`
4. **ビルトイン**: `builtins/{lang}/facets/{type}/`

パッケージのピースは自身のファセットを最優先で見つけつつ、ユーザーやプロジェクトによるオーバーライドも可能です。

## パッケージ管理

### 一覧表示

```bash
takt repertoire list
```

インストール済みパッケージのスコープ、説明、ref、コミット SHA を表示します。

### 削除

```bash
takt repertoire remove @{owner}/{repo}
```

削除前に、ユーザーやプロジェクトのピースがパッケージのファセットを参照していないかチェックし、影響がある場合は警告します。

## ディレクトリ構造

インストールされたパッケージは `~/.takt/repertoire/` に保存されます。

```
~/.takt/repertoire/
  @nrslib/
    takt-fullstack/
      takt-repertoire.yaml          # マニフェストのコピー
      .takt-repertoire-lock.yaml    # ロックファイル（ソース、ref、コミット）
      facets/
        personas/
        policies/
        ...
      pieces/
        expert.yaml
```
