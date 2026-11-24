# director の使い方（実験的）

[English](./director.md) | [日本語](./director.ja.md) | [简体中文](./director.zh-CN.md)

director は依頼を担当の manager に任せ、ゴールの進み具合を確認し、合意の範囲内の質問に答えます。manager は担当するリポジトリの作業を進めます。1つの依頼を任せる manager は1つです。

## 会話を始める

対話端末で次を実行します。

```bash
takt director
```

必要なら daemon が起動します。会話は daemon が保持するため、TUI を閉じて開き直しても続きにつながります。別の担当リポジトリから起動しても同じ会話です。前の画面の発言や返事は再表示されません。

director は実験的機能です。動作、設定、保存するデータの形式は予告なく変わることがあります。人の発言とイベントによるターンには provider の費用がかかります。

## 担当を選ぶ

「ブログに記事一覧のページを足して」のように作業を頼みます。director は `takt_list_managers` の一覧と依頼内容から担当を選びます。人が最初から manager の ID を指定する必要はありません。候補が複数あるなど担当を決められない場合は、ゴールを作らずに候補と確認したい点を示します。

まだ manager がない場所で作業する場合は「/work/new-app でやって」のように Git リポジトリの絶対パスを伝えます。director が `takt_add_manager` で manager を用意すると、その ID が返り、ゴールがなくても一覧に出ます。相対パス、存在しない場所、Git リポジトリでない場所は拒否されます。director が代わりのリポジトリを探し回ることはありません。

本文中の `takt_add_manager` などは director が使う道具の名前です。利用者は会話で依頼します。

## 登録案を1回確認する

担当が決まると、director は担当 manager、リポジトリ、目的、範囲外、受け入れ条件、制約を含む登録案を出します。内容を確かめ、変更があれば会話で伝えて新しい案を確認してください。

TUI では入力欄を空にして `↑↓` で「登録する」を選び、`Enter` で決定します。「登録せずに会話に戻る」を選ぶか `Esc` を押すと登録しません。既定の選択も会話に戻る操作です。

人が1回確認すると担当 manager にゴールが登録されます。manager 側でもう一度確認する必要はありません。ゴールには作成元が `director` であることと、確認した登録案の版が保存されます。人の確認なしに、AI の発言や manager への伝言だけで登録されることはありません。

## Slack で確認する

director の Slack 接続はグローバルの `~/.takt/config.yaml` に設定します。

```yaml
director:
  slack:
    channel_id: C0DIR
    allowed_user_ids: [U0AAA]
```

manager と同じ Slack App を使い、ボットを director のチャンネルへ招待します。daemon を起動するシェルに `TAKT_SLACK_APP_TOKEN` と `TAKT_SLACK_BOT_TOKEN` を設定してください。トークンは設定ファイルに書きません。Slack 設定を変更したら daemon を起動し直します。詳しい接続手順は[設定ガイド](./configuration.ja.md#slack-で-director-と会話する)を参照してください。

登録案は設定したチャンネルにも表示されます。「登録する」ボタンで登録し、「登録せずに会話に戻る」ボタンで登録を取りやめます。英語表示ではそれぞれ「Register goal」「Return to conversation without registering」です。変更前の古い案ではなく、現在の登録案を確認してください。

発言と director の登録・問い合わせボタンには `director.slack.allowed_user_ids` が適用されます。リストにない人が登録ボタンを押しても登録されません。このキーは Slack 設定時に必須で、空配列では誰の発言や操作も受け付けません。manager 用の問い合わせ操作には別の `manager.slack.allowed_user_ids` が適用されます。

許可された人への返事は元のスレッドに届き、新しい通知はターンごとにまとめて投稿されます。操作の受付と処理の完了は別です。登録結果を確認してください。`director.slack` を設定しなければ Slack との送受信は行いません。

## 質問に答える人を分ける

director から作ったゴールの通常質問（`routine`）は director に届きます。たとえば合意した範囲内での実装方法の選択です。manager で直接始めたゴールの質問は、初めは人に届きます。

次の種類はゴールの質問先が director でも人に届きます。

| 種類 | 人に回す内容 |
|------|--------------|
| `permission` | 権限の許可 |
| `irreversible` | 取り返しのつかない操作 |
| `agreement` | 合意の変更 |
| `humanTask` | 人にしかできない作業 |
| `humanFact` | 人しか知らない事実 |
| `unsure` | director が判断に迷った質問 |

director が迷ったときは `takt_escalate_goal_question` でその質問を `unsure` として人に引き継ぎます。ゴール全体の質問先は変えません。人宛ての質問は director の TUI と設定済みの Slack に直接届きます。TUI では `Ctrl+R` で質問を選んで回答し、Slack では質問の選択ボタンやスレッドから回答します。director は人宛ての質問に代理回答しません。

回答者は `answeredBy` に `human` または `director` として記録されます。これは回答経路を示す `source`（`tui`、`slack`、`mcp` など）とは別です。「このゴールの質問と回答を見せて」と頼むと、director は `takt_list_goal_questions` と `takt_get_goal_question` で人の回答を含む履歴を読めます。

## director に任せる・人に戻す

manager で始めたゴールも「このゴールは任せる」と director に指示すれば、通常質問を director に任せられます。これが昇格です。「このゴールは自分で見る」と指示すれば質問先を人に戻せます。対象が分かるようにリポジトリやゴールを伝えてください。

director は現在の人の指示を受けたときだけ `takt_set_goal_question_route` で質問先を変更します。自分の判断や監視イベントでは切り替えません。未回答質問も再振り分けされますが、人に回す6種類は昇格後も人宛てのままです。作成元の `creationOrigin` と過去の回答は変わらず、現在の質問先は `questionRoute` に記録されます。

## manager を外す（fire）

「ブログの manager を外して」のように明示的に頼むと、director は対象を確かめて `takt_fire_manager` を使います。担当内に完成または中止以外のゴールが1つでもあれば拒否され、理由が返って一覧に残ります。一時停止やマージ待ちも未完了に含まれます。

成功すると manager は director の一覧から外れます。リポジトリ、ゴールの記録、ブランチ、会話は残ります。戻したい場合は同じリポジトリの絶対パスを伝えて作業を頼んでください。`takt_add_manager` で用意し直すと一覧に戻ります。長く使わない manager を自動で隠すことや、復帰専用の操作はありません。

## 対応しないこと

daemon の停止中や PC のスリープ中に届かなかった Slack の発言を、チャンネルの履歴から拾い直す機能はありません。Slack の設定を案内するコマンド（`takt director slack init` など）と、director 用 Slack App Manifest の同梱も今回の範囲外です。Slack App は設定ガイドに沿って用意してください。

director はリポジトリの中身や run の内部を調べず、各リポジトリの設定（`main_merge` など）も書き換えません。作業の詳細確認は manager が担います。マージは人が明示的に指示した場合に担当 manager へ伝え、director 自身は実行しません。伝言の受付はマージ成功ではありません。詳しい処理と制限は[ゴール管理ガイド](./goal-management.ja.md#director-の役割)を参照してください。
