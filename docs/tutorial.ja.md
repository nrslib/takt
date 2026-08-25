[English](./tutorial.md) | [日本語](./tutorial.ja.md) | [简体中文](./tutorial.zh-CN.md)

# チュートリアル

このチュートリアルでは TAKT の基本的な使い方を、1 つの題材を 3 フェーズで改良しながら説明します。

題材は **ミニ家計メモ UI** です。最初に小さなフロントエンドを作り、次に使いやすくし、最後に表示と細部を整えます。`default` workflow はレビューやテストを含む標準構成で重めなので、最初の体験では `frontend-mini` を使います。

> **動画チュートリアル:** このチュートリアルに沿って実際に操作する様子を、
> [Chapter 1](https://youtu.be/H_L_slDJNqs)と
> [Chapter 2](https://youtu.be/cfM9USMkh2Y)で確認できます。

## 題材

作るものはブラウザで動く小さな家計メモです。

1. **フェーズ 1:** 金額・カテゴリ・メモを入力できる最小 UI を作る
2. **フェーズ 2:** 合計金額、カテゴリ別フィルタ、削除、永続化を追加する
3. **フェーズ 3:** モバイル表示、空状態、見た目を整える

1 回で全部作らせるより、フェーズごとにタスクを積み、結果を見てから次の改善を指示する流れを体験します。

## 1. GitHub なしで始める

まず、作業対象のプロジェクトを Git リポジトリにします。既存のリポジトリならこの手順は不要です。

```bash
git init
git add .
git commit -m "initial commit"
```

TAKT はタスク実行時にブランチや作業用ディレクトリを扱うため、少なくとも 1 つのコミットがある状態から始めるのが安全です。

TAKT を未インストールの場合は `npm install -g takt` でインストールし、provider の CLI（Claude Code など）または API キーを用意しておきます。

TAKT を起動します。

```bash
takt
```

初回起動時はworkflow 選択の前に、デフォルトのエージェントとワークフローの言語、続いて使用する provider の選択を確認されます。

workflow 選択では`frontend-mini` を選びます。初期状態ではカテゴリだけが並びます。表示順は環境によって多少変わりますが、`frontend-mini` は `レガシー` カテゴリ配下の `フロントエンド` サブカテゴリにあります。

```text
Select workflow:
    📁 🚀 クイックスタート/
    📁 🛠️ 開発/
    📁 🔍 レビュー/
    📁 🏗️ インフラストラクチャ/
    📁 🎵 TAKT開発/
  ❯ 📁 📦 レガシー/
```

workflow の上で `b` キーを押すとブックマークでき、ブックマークした workflow はこの画面の先頭に `🎼 {name} [*]` として表示されます。

カテゴリを開いたら、`frontend-mini` を選びます。

```text
Select workflow in 📦 レガシー:
    📁 ✨ Simple/
    📁 ⚡ Mini/
  ❯ 📁 🎨 フロントエンド/
    📁 ⚙️ バックエンド/
    📁 🔧 デュアル/
    📁 🔍 レビュー/
    🎼 cli
```

```text
Select workflow in 🎨 フロントエンド:
    🎼 simple-frontend
    🎼 frontend
  ❯ 🎼 frontend-mini
    🎼 frontend-maintenance
```

続いてインタラクティブモードの選択が表示されます。まずは **アシスタント** を選びます。

```text
対話モードを選択してください:
  ❯ アシスタント
    Grill Me
    ペルソナ
```

## 2. フェーズ 1: 最小 UI を作る

TAKT と会話して、最初のタスクを説明します。

```text
> ブラウザだけで動くミニ家計メモ UI を作りたい。
> 金額、カテゴリ、メモを入力して一覧に追加できるところまででよい。
> まずは index.html と CSS と JavaScript のシンプルな構成で作って。
```

TAKT が確認質問や整理を返します。内容が固まったら `/go` でタスク指示を作成します。

```text
> /go 最初のフェーズなので、永続化や集計はまだ入れず、最小 UI に絞る
```

タスク指示が生成されると、次のような選択肢が出ます。ここでは **タスクにつむ** を選びます。

```text
どうしますか？
    実行する
  ❯ タスクにつむ
    会話を続ける
    Issueを建てる
```

`タスクにつむ` は生成された指示を `.takt/tasks.yaml` に追記します。`実行する` は即時実行ですが、`Create worktree?`（既定 Yes）を確認されるため、既定では worktree 内での実行になります。通常はタスクに積んでから `takt run` で実行します。

**タスクにつむ** を選ぶと、続いて worktree の設定を確認されます。`Auto-create PR?` の既定は Yes です。GitHub なしで進める場合は `n` を選んでください。

積んだタスクを実行します。

```bash
takt run
```

実行が終わったら、結果を確認します。

```bash
takt list
```

完了したタスクを選ぶと、操作メニューが出ます。まずは **View diff** で差分を確認し、その後 **Try merge** を選びます。

```text
Action for takt/20260201-015714-mini-expense-memo-ui:
  ❯ View diff
    Instruct
    Merge from root
    Pull from remote
    Try merge
    Merge & cleanup
    Delete
```

`Try merge` はタスクブランチの変更をコミットせずに手元へ取り込みます。手元で画面や差分を確認し、問題なければ自分でコミットできます。

```text
Action for takt/20260201-015714-mini-expense-memo-ui:
    View diff
    Instruct
    Merge from root
    Pull from remote
  ❯ Try merge
    Merge & cleanup
    Delete
```

## 3. フェーズ 2: 機能を足す

フェーズ 1 の結果を確認して、次の改善を積みます。新しいタスクとして `takt` から始めてもよいですし、完了タスクに対して `takt list` の **Instruct** を使ってもよいです。

既存結果を踏まえて改善する場合は`takt list` で完了タスクを選び、**Instruct** を選びます。

```text
Action for takt/20260201-015714-mini-expense-memo-ui:
    View diff
  ❯ Instruct
    Merge from root
    Pull from remote
    Try merge
    Merge & cleanup
    Delete
```

Instruct では前回の差分や実行レポートを踏まえて追加指示を相談できます。

```text
> フェーズ 2 として、合計金額、カテゴリ別フィルタ、行の削除を追加して。
> 入力済みデータは LocalStorage に保存して、リロードしても残るようにして。
```

内容が固まったら `/go` します。

```text
> /go 既存 UI を大きく作り直さず、今の構成に足す形にする
```

選択肢では再び **タスクにつむ** を選びます。

```text
どうしますか？
  ❯ タスクにつむ
    会話を続ける
```

実行して、結果を確認します。

```bash
takt run
takt list
```

この段階でもまずは **View diff**、必要なら **Try merge**、気に入らなければ **Instruct** という順で進めます。

## 4. フェーズ 3: 仕上げる

最後に見た目と使い勝手を整えます。ここも **Instruct** で既存成果を見せながら追加指示を作るのが向いています。

```text
> フェーズ 3 として、モバイル幅でも崩れないようにして。
> 入力が空のときの empty state、フォーカス表示、カテゴリの見た目も整えて。
> 派手なランディングページではなく、日常的に使える小さなツールとして仕上げて。
```

`/go` でタスク指示を確定します。

```text
> /go
```

今回も **タスクにつむ** を選びます。

```text
どうしますか？
  ❯ タスクにつむ
    会話を続ける
```

実行します。

```bash
takt run
```

最後に `takt list` で確認し、問題なければ **Merge & cleanup**、手元で確認してから決めたい場合は **Try merge** を使います。

```text
Action for takt/20260201-015714-mini-expense-memo-ui:
    View diff
    Instruct
    Merge from root
    Pull from remote
    Try merge
  ❯ Merge & cleanup
    Delete
```

基本の流れは次の繰り返しです。

```text
takt
  -> frontend-mini を選ぶ
  -> アシスタントで会話する
  -> /go
  -> タスクにつむ
takt run
takt list
  -> View diff
  -> Try merge または Merge & cleanup
  -> 必要なら Instruct して次フェーズを積む
```

## 5. GitHub Issue を作ってからタスクに積む

GitHub リポジトリで作業している場合はTAKT との会話から GitHub Issue を作り、その Issue をタスクとして積めます。

事前に GitHub CLI を認証しておきます。

```bash
gh auth status
```

TAKT を起動し、`frontend-mini` を選びます。

```bash
takt
```

TAKT と会話して、Issue にしたい内容を整理します。

```text
> ミニ家計メモ UI のフェーズ 2 として、合計金額、カテゴリ別フィルタ、削除、LocalStorage 保存を追加したい。
> 受け入れ条件も Issue に書けるように整理して。
```

内容が固まったら `/go` を実行します。

```text
> /go
```

提案されたタスク指示を確認し、まず **Issueを建てる** を選びます。

```text
どうしますか？
    実行する
    タスクにつむ
    会話を続ける
  ❯ Issueを建てる
```

`Issueを建てる` はIssue の作成とタスクの保存を一連で実行します。Issue 作成後はそのまま worktree 設定の確認が続きます（メニューには戻りません）。Issue 番号が分かっている場合は次のように追加することもできます。

```bash
takt add #1
```

あとはローカル運用と同じです。

```bash
takt run
takt list
```

GitHub Issue を経由すると、要件・議論・実装タスクの対応関係が残りやすくなります。チーム開発ではこの流れが扱いやすいです。

## 6. Codex などと会話して Issue を作り、TAKT に渡す

TAKT の外で Codex などの開発支援 AI と会話しながら Issue を作った場合もTAKT には Issue 番号だけを渡せます。

まず、Codex などで GitHub Issue を作成します。ここでは `#1` が作られたとします。

```bash
takt add #1
```

`takt add #1` は GitHub Issue のタイトル・本文・コメントを取得し、TAKT の pending タスクとして保存します。

実行します。

```bash
takt run
```

結果を確認します。

```bash
takt list
```

この流れではIssue 作成までは普段使っている AI や GitHub 上のやり取りに任せ、実装・レビュー・修正ループを TAKT に担当させます。

## 次に読むもの

- [タスク管理](./task-management.ja.md): `takt add`、`takt run`、`takt list` の詳細
- [CLI リファレンス](./cli-reference.ja.md): コマンドとオプション一覧
- [設定ガイド](./configuration.ja.md): provider、model、workflow などの設定
