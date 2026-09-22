# Reply Desk

問い合わせを選び、返信文を編集して保存する小規模な React / TypeScript / Vite アプリです。外部サービスは使わず、保存処理はブラウザ内の非同期処理で再現しています。

## 起動方法

```bash
npm install
npm run dev
```

表示されたローカルURLをブラウザで開いてください。配布用ビルドは `npm run build`、ビルド結果の確認は `npm run preview` で行えます。

## 操作方法

- 左側の問い合わせ一覧から対象を選び、右側の「返信を編集」で本文を編集します。
- 「返信を保存」または入力欄で `Ctrl + Enter` / `Command + Enter` を押すと保存します。通常の `Enter` は改行です。
- 保存中は約1秒かかり、対象の切り替えと返信の編集を停止します。保存操作を連打しても、受け付けた一回だけが実行されます。
- 空白だけの返信は保存できません。失敗した保存は「入力内容を保持しています」と表示し、そのまま再試行できます。
- 「保存済みに戻す」で現在の下書きを保存済み内容へ戻せます。
- 「次の保存を失敗させる」を有効にすると、次に受け付けた保存だけ失敗します。失敗後にもう一度保存すると成功します。
- 未保存の編集があるときに別の問い合わせを選ぶと、編集を破棄して切り替えるか、切り替えをやめるか確認します。
- ヘッダーと返信欄の「操作ガイド」は同じ操作説明ダイアログを開きます。ダイアログは `Escape` または閉じるボタンで閉じられ、背景へフォーカスが抜けないようにしています。
- 一覧上部の検索欄で、名前・件名・問い合わせ本文・保存済み返信を検索できます。

## 選んだ設計と6文書との関係

- `App` を Root とし、`Header`、`InquiryList`、`InquiryDetail`、`StatusPanel`、`ModalDialog` を表示部品として組み立てました。表示部品は props を描画し、操作の意図を親へ通知します。
- 問い合わせ一覧、選択中ID、返信の下書き、保存状態、受け付けた保存回数は `workspaceReducer` に集約しました。検索語とダイアログの開閉は App の局所 state です。
- `handleSave`、`handleSelectInquiry`、`handleRestore` が現在の状態を確認して操作を受理・拒否する Mediator です。保存ボタンとキーボード操作は同じ保存処理へ入り、reducer は状態更新だけを行い、1秒の timer はイベントハンドラ側で開始します。
- 保存開始・成功・失敗、空白入力、未保存の切り替え確認をそれぞれ画面へ反映し、保存後は一覧の `savedReply` も同じ state から更新します。
- `criteria/knowledge-gui.md` と `criteria/policies-gui.md` には、Rootからの部品構成、状態の共有範囲、Passive View、Mediator、確認中・処理中の競合操作の扱いで対応しています。
- `criteria/knowledge-frontend.md` と `criteria/policies-frontend.md` には、検索結果の空状態、更新後の一覧反映、適切なボタン・フォーム、通信結果の表示、直接のHTML挿入を行わない実装で対応しています。URL指定やページングは仕様にないため追加していません。
- `criteria/knowledge-react.md` と `criteria/policies-react.md` には、reducerによる状態遷移、controlled textarea、派生値の描画時計算、イベントハンドラでのtimer開始、Effectのcleanup、安定IDによる `key` で対応しています。
- 入力と label、`aria-describedby`、`aria-invalid`、`aria-live`、`aria-current` を関連付けました。ダイアログは `role="dialog"`、`aria-modal="true"`、フォーカス移動・フォーカストラップ・Escape・復帰先を実装しています。入力値は React のテキスト表示と controlled textarea で扱い、HTML へ直接挿入していません。
- URL指定、ページング、外部API、永続化は仕様にないため追加していません。固定された小規模集合を一度に表示する設計です。

## 検証したこと

- `npm run build` を実行し、TypeScript の型検査と Vite の本番ビルドが成功することを確認しました。
- 初期問い合わせ4件の表示、検索結果が0件の表示、一覧選択、通常の改行、ボタン保存、`Ctrl + Enter` / `Command + Enter` 保存を実装しています。
- 空白のみの入力拒否、保存中の対象切り替え拒否、保存連打時の受付回数、未保存切り替え確認、保存済みへ戻す操作、失敗後の再試行、一覧と詳細の保存結果反映を確認できる状態にしています。
