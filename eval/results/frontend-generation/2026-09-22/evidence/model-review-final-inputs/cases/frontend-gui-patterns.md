# UI実装のレビュー

対象の各ファイルを独立した実装としてレビューしてください。ファイル名や他の実装との類似だけで判定せず、以下の仕様とコードを根拠にしてください。対象外のコードや採点設定は調査不要です。

- `src/gui-patterns/selection-a.tsx` と `selection-b.tsx`: Pickerで選んだ値をDetailsにも直ちに表示する。
- `src/gui-patterns/buyer-a.tsx` と `buyer-b.tsx`: 親が管理する購入者の氏名を編集する。更新通知を受けた親が新しい値を渡す。
- `src/gui-patterns/total-a.tsx` と `total-b.tsx`: 商品は1個100円。AddとClearのどちらでも数量と合計を一致させる。
- `src/gui-patterns/submit-a.tsx` と `submit-b.tsx`: 1回の送信操作につきsaveを1回呼ぶ。recordClickは操作記録用で、保存は行わない。
- `src/gui-patterns/save-a.tsx` と `save-b.tsx`: ボタンとCtrl+Sの両方で保存できる。statusがeditingのときだけsaveを呼べる。親が保存開始・完了に合わせてstatusを更新する。
- `src/gui-patterns/row-a.tsx` と `row-b.tsx`: ワークスペース画面と検索画面で共用する行。各画面が削除対象のワークスペース、削除処理、削除後の移動先を決める。removeは同期処理。
- `src/gui-patterns/query-a.tsx` と `query-b.tsx`: アカウントに対応する注文を表示する。同一QueryClientProvider内で、別アカウントの一覧を同時に表示し、表示中のaccountIdも変更できる。TanStack Query v5を使用。loadは渡されたアカウントの注文ID一覧を返す。
- `src/gui-patterns/subscription-a.tsx` と `subscription-b.tsx`: 現在のchannelからのみメッセージを受信する。channelは表示中に変更される。subscribeは購読解除関数を返す。部品が消えたら購読を終了する。
- `src/gui-patterns/context-dispatch.tsx`: SelectionProvider内でUserSelectionButtonを使い、選択結果をProviderのoutputへ表示する。
- `src/gui-patterns/local-state.tsx`: 入力中の検索語はこの部品だけで保持し、Enterで確定した検索語を親へ通知する。
- `src/gui-patterns/callback-delegation.tsx`: 行の選択を一覧の呼び出し元へ通知する。
- `src/gui-patterns/draft.tsx`: ダイアログを開くたびに新規マウントする。編集中の値はConfirmまで親へ反映せず、initialNameはこの表示中には変わらない。
- `src/gui-patterns/shared-query.tsx`: 同じアカウントの注文を2箇所に表示し、同じQueryClientのキャッシュを共有する。
- `src/gui-patterns/bubble-a.tsx` と `bubble-b.tsx`: Rootがrecordsのremove処理を持ち、ScreenがRecordActionsのselect状態を持つ。Screenが担当するselectをRootへ実行させず、担当しないremoveだけをRootへ一度通知する。
- `src/gui-patterns/guard-a.tsx` と `guard-b.tsx`: Rootが保存処理を持ち、ScreenのrequestSaveが現在のediting/saving状態と入力を確認する。拒否した空入力や処理中の要求をRootへ渡さず、受理した保存だけを親で1回実行する。
- `src/gui-patterns/mediator-a.tsx` と `mediator-b.tsx`: RootのMediatorが保存開始、成功、失敗を現在stateへ反映し、ScreenとSaveFormがsaving/saved/errorの表示を受け取る。saveの成功と失敗を実際のPromise結果からそれぞれ追える。
- `src/gui-patterns/confirmation-a.tsx` と `confirmation-b.tsx`: 編集を破棄する確認を表示している間に、画面が公開するrequestSaveへ保存要求が来る。確認待ちの間は保存を開始せず、ボタンのdisabled表示だけに依存せずhandlerで判断する。確認待ちの保存要求がなければ、編集内容を1回だけ保存する。
- `src/gui-patterns/modal-a.tsx` と `modal-b.tsx`: 保存確認をモーダルで表示する。確認待ちの同じrequestSaveは拒否し、モーダルを開いたときに内部へfocusを移し、閉じる操作とEscapeで閉じ、元のトリガーへfocusを戻す。モーダル中は背景のTab移動と操作を受け付けず、dialogのaccessible nameを持たせる。
- `src/gui-patterns/form-action.tsx`: React 19の`useActionState`でformの`action`へ処理を渡し、成功・入力不備のstateとpending表示を描画する。

最終出力はJSON配列だけにしてください。対象32ファイルを1回ずつ含め、各要素を `{"file":"src/gui-patterns/ファイル名.tsx","verdict":"OK または REJECT","reason":"コード中の識別子と操作の流れを挙げた具体的理由"}` としてください。判定理由は日本語で記述してください。
