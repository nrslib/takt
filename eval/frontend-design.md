# GUI・フロントエンドのプロンプト評価

`frontend` は Luna、`frontend-opus` は Opus で同じ課題をレビューする。Lunaで判定と理由を確認し、必要な修正を終えてからOpusを実行する。各suiteは、`frontend-review`（`review-frontend` workflow）と`frontend-review-react`（`frontend` workflow）という異なるworkflow構成で同じ課題をレビューする。後者はReactナレッジを含み、他のレビュー用ファセットも加わるため、比較をReactナレッジだけの有無として扱わない。

```sh
npm run build
node eval/scripts/prepare.mjs frontend-review frontend-review-react
npm run eval:prompts -- frontend --no-cache
npm run eval:prompts -- frontend-opus --no-cache
# 6 fixtureの実ブラウザ検証に必要なReactとReactDOMを一時ディレクトリへ用意する
(
  set -e
  frontend_deps="$(mktemp -d)"
  trap 'rm -rf "$frontend_deps"' EXIT
  npm install --prefix "$frontend_deps" --no-save --package-lock=false react@19.2.8 react-dom@19.2.8
  node eval/scripts/frontend-gui-browser.mjs --dependency-dir "$frontend_deps/node_modules"
)
```

課題は `cases/frontend-gui-patterns.md`、コードは `fixtures/frontend-design/`、期待判定は `asserts/frontend-gui.mjs` にある。CLI providerは構成ごとにprepareが作成した実行ディレクトリと、その構成のファセットスナップショットだけを一時ディレクトリへコピーして実行する。期待判定と採点コードはコピーしない。

## 比較する設計

各組は同じ仕様を満たすための実装を比較する。ファイル名のa/bは判定を表さない。

| 課題 | 問題のある実装 | 適切な実装 | 判断する理由 |
|------|----------------|------------|--------------|
| 兄弟部品の選択表示 | selection-a | selection-b | 選択値を別々に持つとDetailsへ反映されない。共通親の値を両方へ渡す |
| 親が持つ氏名の編集 | buyer-b | buyer-a | propsへの直接代入を、親への更新通知に変える |
| 数量と合計 | total-a | total-b | Clear時に合計の更新を忘れる。数量から合計を計算する |
| フォーム送信 | submit-b | submit-a | clickとsubmitの両方から保存する。保存をsubmitへまとめる。祖先の操作記録は別の処理 |
| 状態に応じた保存 | save-a | save-b | キーボード経路が保存可否の判定を通らない。両方の入口から同じ保存処理へ渡す |
| 複数画面で共用する行 | row-a | row-b | 行が特定画面のURL構造と移動先を知っている。削除を呼び出し元へ通知する |
| アカウント別の取得 | query-b | query-a | キャッシュを区別するキーにアカウントが含まれない。取得条件をキーに含める |
| 対象変更と購読終了 | subscription-a | subscription-b | 最初の対象を購読したまま解除しない。対象変更時に解除・再購読する |
| 未担当操作の上位通知 | bubble-a | bubble-b | Screenで処理したselectまでRootへ渡す。担当しないremoveだけを上位へ通知する |
| 拒否・処理済み操作の再実行 | guard-a | guard-b | 状態や入力で拒否した要求もRootへ渡す。受理した保存と拒否した要求を同じ親処理へ流さない |
| Mediatorの状態と表示 | mediator-a | mediator-b | 保存成功時の次状態を反映しない。開始・成功・失敗をstateへ反映し表示へ渡す |
| 確認待ちの保存要求 | confirmation-a | confirmation-b | 破棄確認中にrequestSaveを受理して保存開始を許す。ボタンのdisabled表示ではなくhandlerで確認状態を判断する |
| 保存確認モーダル | modal-a | modal-b | custom role dialogで背景のTab移動・操作を抑止できない。native dialogによる背景操作の抑止、開閉focus、Escape、accessible nameを確認する |

加えて、Contextからのdispatch、入力中のローカルstate、callbackの受け渡し、確定前の下書き、同じQueryClientのキャッシュ共有、React 19の`useActionState`とform `action`の6例を適切な実装として評価する。合計は13組の比較と6例の単独実装、32ファイルである。

## 採点

- 適切な19例への判定と、不適切な13例の検出を別々に集計する。
- JSON配列を囲む単一のMarkdownコードブロックは、外側を除いて内容を採点する。JSONのみを求めた課題への形式違反は別に記録し、設計判断の失敗に数えない。前後の文章や複数のJSON断片から都合のよい箇所を抜き出さない。
- 全32ファイルのJSON判定を要求する。欠落、重複、矛盾、対象外ファイル、空の理由は不合格にする。
- 自動採点は事前確認である。判定と理由中のコード識別子・語句を検査するが、語句の一致だけで因果関係を保証しない。正しいラベルでも別の理由で拒否した回答は、回答原文の意味確認で不合格とする。
- 正規表現だけでは理由の意味を保証できない。回答原文を読み、コードと因果関係が一致するか確認してから結果を報告する。

従来の21例は部品単位のコードレビュー用であり、下書きの再マウントや行の呼び出し元の責務は課題で与えた前提として扱う。追加した委譲・拒否・状態遷移・確認待ち・モーダルの5組とform actionの例は、Root・画面・表示部品のコードを含む。コードレビューの採点と実ブラウザ検証は別の証拠として扱う。

## 実ブラウザ検証

`eval/scripts/frontend-gui-browser.mjs` は、`--dependency-dir` で指定した依存ディレクトリを一時Viteアプリへリンクし、6つのfixtureを1つずつPlaywrightで起動する。ViteとPlaywrightはリポジトリの開発依存を使う。guardの組では空入力と処理中の要求が保存へ到達するか、非同期保存のsavingからeditingへの復帰、保存内容、拒否メッセージの消去、完了後の再保存を確認する。guardの非同期保存はPlaywrightの時計を明示的に停止し、壁時計が経過してもsavingが続き、時計を進めたときだけ完了することも確認する。確認待ちの組では確認中にsave callbackへ届く要求が受理されるかを、通常保存のpositive controlと保存回数・保存内容で確認する。モーダルの組ではdialogの名前、確認中の再要求、Tabによる背景focus、背景操作、Escape、トリガーへのfocus復帰、確認完了を、ブラウザのDOMと操作結果で確認する。

この実行でNG fixtureが仕様どおり崩れることは、既存実装の不具合を再現した証拠であり、プロンプト改善のREDとは呼ばない。プロンプトのRED/GREENは、同一ケースを旧・新プロンプトでレビューした採点結果の変化として別に記録する。モデル回答のラベル一致だけでは改善と判定せず、回答原文の理由とコードの因果関係を確認する。

## 旧・新プロンプトの比較

変更前のrevisionから生成したプロンプトと、参照される全スナップショットを保存する。変更後のスナップショットを旧プロンプトから読ませない。両条件で同じ課題・コード・モデル・effort・実行権限を使い、期待判定を含まない一時ディレクトリで新規セッションとして実行する。

記録するものは、revision、プロンプトとスナップショットのハッシュ、課題とコードのハッシュ、モデル設定、回答原文、ケース別の判定と理由である。旧・新それぞれについて、検知漏れと誤検知を区別する。

悪いコードを用意しただけではREDではない。旧プロンプトで期待判定との不一致を観測したケースをREDとし、同じケースが変更後に通ったことをGREENとする。旧版も通ったケースは回帰確認であり、改善実績として数えない。1回の成功は、その試行での結果として報告する。

2026-09-21〜22の実モデル比較と回答原文は [評価結果](results/frontend-design.md) を参照。

実装生成による基準の検証は[生成評価の要約](results/frontend-generation.md)を参照。
