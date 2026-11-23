# GUI・フロントエンドのプロンプト評価

`frontend` は Luna、`frontend-opus` は Opus で同じ課題をレビューする。Luna で判定と理由を確認し、必要な修正を終えてから Opus を実行する。各 suite では、`frontend-review`（`review-frontend` workflow）と `frontend-review-react`（`frontend` workflow）の2構成を比較する。後者には React ナレッジのほかにもレビュー用ファセットが加わるため、React ナレッジの有無だけを比べる評価にはならない。

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

課題は `cases/frontend-gui-patterns.md`、コードは `fixtures/frontend-design/`、期待する判定は `asserts/frontend-gui.mjs` にある。CLI provider の実行時には、prepare が構成ごとに作った実行ディレクトリと、その構成のファセットスナップショットだけを一時ディレクトリにコピーする。期待する判定と採点コードはコピーしない。

## 比較する設計

各組は同じ仕様を満たすための実装を比較する。ファイル名のa/bは判定を表さない。

| 課題 | 問題のある実装 | 適切な実装 | 判断する理由 |
|------|----------------|------------|--------------|
| 兄弟部品の選択表示 | selection-a | selection-b | 選択値を別々に持つとDetailsへ反映されない。共通親の値を両方へ渡す |
| 親が持つ氏名の編集 | buyer-b | buyer-a | propsへの直接代入を、親への更新通知に変える |
| 数量と合計 | total-a | total-b | Clear時に合計の更新を忘れる。数量から合計を計算する |
| フォーム送信 | submit-b | submit-a | clickとsubmitの両方から保存する。保存をsubmitへまとめる。祖先の操作記録は別の処理 |
| 状態に応じた保存 | save-a | save-b | キーボード操作では保存の可否を判定していない。どちらの操作でも同じ保存処理を呼び出す |
| 複数画面で共用する行 | row-a | row-b | 行の実装が特定画面の URL 構造と移動先に依存する。削除を呼び出し元へ通知する |
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
- 自動採点では、判定と理由に含まれるコード識別子・語句を事前に検査する。語句が一致しても理由が正しいとは限らないため、ラベルが正しくても別の理由で拒否した回答は、回答原文を確認して不合格とする。
- 正規表現だけでは理由の意味を保証できない。回答原文を読み、コードと因果関係が一致するか確認してから結果を報告する。

従来の21例は部品単位のコードレビュー用であり、下書きの再マウントや行の呼び出し元の責務は課題で与えた前提として扱う。追加した委譲・拒否・状態遷移・確認待ち・モーダルの5組とform actionの例は、Root・画面・表示部品のコードを含む。コードレビューの採点と実ブラウザ検証は別の証拠として扱う。

## 実ブラウザ検証

`eval/scripts/frontend-gui-browser.mjs` は `--dependency-dir` で指定した依存ディレクトリを一時的な Vite アプリへリンクし、6つの fixture を1つずつ Playwright で起動する。Vite と Playwright はリポジトリの開発依存を使う。

guard の組では、空入力や処理中の要求で保存処理が呼ばれるか、非同期保存の saving から editing への復帰、保存内容、拒否メッセージの消去、完了後の再保存を確認する。非同期保存では Playwright の時計を明示的に停止し、実時間が経過しても saving が続き、時計を進めたときだけ完了することも確認する。

確認待ちの組では、確認中に save callback へ届く要求が受理されるかを調べる。正しく動作する通常保存の例と比べ、保存回数と保存内容を確認する。モーダルの組では、dialog の名前、確認中の再要求、Tab による背景への focus 移動、背景操作、Escape、トリガーへの focus 復帰、確認完了を、ブラウザの DOM と操作結果で確認する。

この実行で NG fixture の不具合を想定どおりに再現しても、プロンプト改善の RED を確認したことにはならない。プロンプトの RED/GREEN は、同じケースを旧・新プロンプトでレビューし、採点結果の変化として別に記録する。改善の判定ではモデル回答のラベルだけを見ず、回答原文の理由がコードの因果関係と一致するかを確認する。

## 旧・新プロンプトの比較

変更前のrevisionから生成したプロンプトと、参照される全スナップショットを保存する。変更後のスナップショットを旧プロンプトから読ませない。両条件で同じ課題・コード・モデル・effort・実行権限を使い、期待判定を含まない一時ディレクトリで新規セッションとして実行する。

記録するものは、revision、プロンプトとスナップショットのハッシュ、課題とコードのハッシュ、モデル設定、回答原文、ケース別の判定と理由である。旧・新それぞれについて、検知漏れと誤検知を区別する。

旧プロンプトの判定が期待と一致しなかったケースを RED とし、同じケースが変更後に通ったことを GREEN とする。不具合のあるコードを用意するだけでは RED を確認できない。旧プロンプトでも通ったケースは回帰確認に使い、改善の実績には数えない。1回の成功は、その試行での結果として報告する。
