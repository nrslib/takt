# Repertoire パッケージ

[English](./repertoire.md)

Repertoire パッケージを使うと、GitHub リポジトリから TAKT の workflow やファセットをインストール・共有できます。

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

`{owner}/{repo}` はインストール時に小文字化されて保存されるため、`takt repertoire remove` には `takt repertoire list` の表示どおり小文字で指定してください。

[GitHub CLI](https://cli.github.com/) (`gh`) のインストールと認証が必要です。

## パッケージ構造

TAKT パッケージはマニフェスト `takt-repertoire.yaml` とコンテンツのディレクトリを含む GitHub リポジトリです。

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
  workflows/
    expert.yaml
  provider-options/
    readonly.yaml
  steps/
    final-gate.yaml
  facet-pools/
    implementation-fix.yaml
```

`facets/`、`workflows/`、`provider-options/`、`steps/`、`facet-pools/` ディレクトリだけがインポートされます。その他のファイルは無視されます。

### takt-repertoire.yaml

マニフェストにはリポジトリ内でパッケージのコンテンツを配置した場所を記述します。

```yaml
# 説明（任意）
description: フルスタック開発用 workflow とエキスパートレビュアー

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
| `path` | いいえ | `.` | パッケージのコンテンツを収めた各ディレクトリの親ディレクトリへのパス |
| `takt.min_version` | いいえ | - | 必要な TAKT の最低バージョン（X.Y.Z 形式） |

## インストール

```bash
takt repertoire add github:{owner}/{repo}@{ref}
```

`@{ref}` は省略可能です。省略した場合、リポジトリのデフォルトブランチが使用されます。

インストール前に、ファセットの種別ごとの数、workflow 名、`steps/` 直下の fragment 名、edit 権限の警告が表示され、インストールを承認するかどうか尋ねられます。

### インストール時の処理

1. `gh api` 経由で GitHub から tarball をダウンロード
2. `facets/`、`workflows/`、`provider-options/`、`facet-pools/` からパッケージファイルを展開（`.md`、`.yaml`、`.yml`）。`steps/` は直下の `.yaml` / `.yml` step fragmentのみを展開
3. `takt-repertoire.yaml` マニフェストをバリデーション
4. TAKT バージョン互換性チェック
5. `~/.takt/repertoire/@{owner}/{repo}/` にファイルをコピー
6. ロックファイル（`.takt-repertoire-lock.yaml`）を生成（ソース、ref、コミット SHA）

インストールはアトミックに行われ、途中で失敗しても一部だけがインストールされた状態にはなりません。

### セキュリティ制約

- `.md`、`.yaml`、`.yml` ファイルのみコピー
- シンボリックリンクはスキップ
- 1 MB を超えるファイルはスキップ。ただし、`steps/` 直下の step fragment が上限を超えた場合は、パッケージのインストールを拒否
- 500 ファイルを超えるパッケージは拒否
- `path` フィールドのディレクトリトラバーサルを拒否
- realpath で symlink の参照先を確認し、ディレクトリトラバーサルを検出
- `steps/` は直下の `.yaml` / `.yml` step fragmentのみを受理し、ネストしたファイルと非YAMLファイルはインストールしない

## パッケージの使い方

### ワークフロー

インストールされた workflow は workflow 選択 UI の「repertoire」カテゴリにパッケージごとのサブカテゴリとして表示されます。直接指定も可能です。

```bash
takt --workflow @nrslib/takt-fullstack/expert
```

### @scope 参照

インストール済みパッケージのファセットはworkflow YAML で `@{owner}/{repo}/{facet-name}` 構文を使って参照できます。

```yaml
steps:
  - name: implement
    persona: '@nrslib/takt-fullstack/expert-coder'
    policy: '@nrslib/takt-fullstack/strict-review'
    knowledge: '@nrslib/takt-fullstack/domain'
```

インストール済みパッケージの provider-options capability preset も、同じ scoped 構文で `capabilities` から参照できます。repertoire パッケージ内の workflow では、パッケージ内の `provider-options/` をプロジェクト、ユーザー、ビルトインの provider-options ディレクトリより先に検索します。workflow YAML では capability preset だけを参照し、provider/model/options は `runtime.yaml` または既存の legacy config layer に置きます。

preset または path を解決できない場合や、scoped ref で指定した repertoire パッケージが利用できない場合は、設定エラーとして capability preset の解決を直ちに停止します。参照先 YAML が不正または provider-options object でない場合、extends チェーンが循環している場合、削除済みの `$ref` キーが使われた場合も同様です。

相対 path はその参照を書いたファイルのディレクトリを基準に解決します。workflow から path 形式の参照だけをたどる場合、相対 path は workflow のディレクトリ内に制限されます。名前付き preset または scoped preset を読み込むと、その先の相対 path は読み込んだ preset のディレクトリ内に制限されます。symlink 解決後の実体もこの範囲内に留まる必要があります。絶対 path と、実体がこの範囲外へ出る path は拒否されます。

```yaml
capabilities: '@nrslib/takt-fullstack/edit'
```

### 4層ファセット解決

repertoire パッケージの workflow が名前（@scope なし）でファセットを解決する場合、次の順序で検索されます。

1. **パッケージローカル**: `~/.takt/repertoire/@{owner}/{repo}/facets/{type}/`
2. **プロジェクト**: `.takt/facets/{type}/`
3. **ユーザー**: `~/.takt/facets/{type}/`
4. **ビルトイン**: `builtins/{lang}/facets/{type}/`

パッケージの workflow はパッケージ内の同名ファセットを最優先で使用します。同名のプロジェクト・ユーザーファセットで上書きすることはできません。

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

`{owner}/{repo}` はインストール時に小文字化されるため、`takt repertoire list` の表示どおり小文字で指定します。削除前に、ユーザーやプロジェクトの workflow、provider-options preset、step fragment がパッケージを参照していないかチェックし、影響がある場合は警告します。

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
      workflows/              # repertoire パッケージ内の workflow 定義
        expert.yaml
      provider-options/        # 共有 provider_options プリセット
        readonly.yaml
      steps/                   # 再利用可能な step fragment
        final-gate.yaml
      facet-pools/             # 再利用可能な dynamic facet pool resource
        implementation-fix.yaml
```
