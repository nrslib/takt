# Backend review

## 結果: REJECT

- finding_id: PAGINATION-001
- 状態: new
- 場所: src/history.mjs:2-8
- 問題: 対象テナントの全行をSQLのall()で実体化してからslice()で20件に絞っている。
- 根拠: SQLにLIMIT/OFFSETがない。READMEにレコード数の上限はなく、ページサイズは20件。directoryは最大21件しか取得しない。
- 影響: 一覧の1ページを取得するためのアプリ側の読み込み量が全レコード数に比例する。
- 修正: DB側でページの範囲と取得上限を適用し、返却20件とhasMoreを維持する。
- 受入条件: DBからの取得量がテナント全件数ではなくページに必要な件数に制限されること。
- 正常例: directoryの21件取得後の切り出しと、固定6項目のcategoriesに問題はない。
