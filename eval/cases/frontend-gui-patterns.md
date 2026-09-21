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

最終出力はJSON配列だけにしてください。対象21ファイルを1回ずつ含め、各要素を `{"file":"src/gui-patterns/ファイル名.tsx","verdict":"OK または REJECT","reason":"コード中の識別子と操作の流れを挙げた具体的理由"}` としてください。判定理由は日本語で記述してください。
