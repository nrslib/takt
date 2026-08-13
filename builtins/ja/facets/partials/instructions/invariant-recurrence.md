**不変条件の再発:**

- verifier occurrence は、修正後に完了した1つの verifier 結果とする。同一 sweep で1つの不変条件について複数経路を報告しても1 occurrence と数え、修正を挟んだ後続結果だけを次の occurrence と数える
- family ID、不変条件の安定ID、authoritative owner が一致する記録だけを同一の観測可能な不変条件とする。記録された前回と今回の `participates` 経路が異なる場合を別経路とする
- 同一不変条件が別々の occurrence で2回以上 `incomplete` となり、今回の経路が直前の incomplete occurrence と異なる場合だけ、再発トリガーを新たに成立させる。累積 `incomplete` 回数は、不変条件ごとに1 occurrence につき最大1回だけ増やす
- 同一台帳行のトリガーは、引き継いだトリガー OR 今回新たに成立したトリガーとする。family ID、不変条件の安定ID、authoritative owner が一致する行で一度成立したトリガーは、同一経路で再失敗した場合を含む以後の occurrence でも成立を維持する。明示的な計画変更または不変条件の安定ID変更を行い、その変更理由を記録した場合だけ不成立へ戻せる
- verifier は fix-report の「不変条件台帳の引き継ぎ」だけから履歴を読む。fix は計画済みの全不変条件について1行ずつ維持し、初回 fix では fix-plan から occurrence なし・累積回数 `0`・トリガー不成立で初期化し、検証後は最新の fix-verification に存在する再発記録の全行を無変更で転記する。後続記録が計画済み不変条件を欠く場合は、回数を0へ戻さず、計画の同一性情報と判定不能の再発項目で行を補い、欠落を引き継ぎ不足として別途記録する。occurrence の設定、回数の加算、トリガー判定は verifier だけが行い、今回の sweep で `incomplete` でない不変条件も行を落とさず出力する
- family ID と不変条件の安定IDが一致する引き継ぎ行がない場合、または一致する初期行に verifier occurrence がない場合は、初回 occurrence として扱う。同一の観測可能な不変条件が別の安定IDで再登場した場合だけ、計画不整合として記録する
- 今回の sweep で不変条件が `incomplete` でない場合は、記録済みの incomplete occurrence、経路、回数、トリガーを移動・変更せず、今回の判定だけを「維持」とする。これにより非連続の verifier occurrence 間でも直前の incomplete 経路を保持する
- 引き継ぎ履歴の不足またはID不一致を非再発として扱わない。成果物側の不足項目は fix-plan の台帳から再構築し、全計画不変条件の行を維持して、理由を成果物不足として記録する。計画側の同一性情報、authoritative owner、または条件付きで必須となる強制点の不足・不整合は計画不足として記録する
