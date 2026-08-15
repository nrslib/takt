現在のコードと現在のレビュー裁定から、要件充足、前段 finding の解消状態、再発台帳の引き継ぎを判定してください。

{{include:instructions/invariant-recurrence}}
{{include:instructions/contract-family-final-preservation}}

**現在のレビュー裁定:**
{report:review-resolution.md}

1. 元要件を独立に判定できる最小単位へ分解し、現在のコードへ対応付ける
2. 前段 finding は元の受入条件へ戻って解消状態を確認する
3. 現在の review-resolution.md にある「再発台帳の引き継ぎ」の引き継ぎ元と全行を、最終裁定で書く review-resolution.md の同名節へ無変更で記載する
4. 全要件が充足し前段 finding が解消済みなら APPROVE とする
5. 未充足要件または未解消 finding があれば REJECT とし、修正対象 family、受入条件、最小の修正境界を記録する
6. 現在のコードと現在のレビュー裁定だけでは要件を判定できず、必要な外部判断または情報をタスク範囲のコード変更で得られない場合だけ BLOCKED とする

テスト・ビルドを含む機械ゲートの実行状況、結果、ログは、品質ゲートの名目でも要件充足の名目でも要求・審査しないでください。その欠如を REJECT または BLOCKED の理由にしてはいけません。
