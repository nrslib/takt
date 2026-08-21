`channel` オプションは公開境界で一度だけ正規化してください。受理する値は `local` と `cloud` で、大文字小文字を区別せず、前後の空白を無視します。すべての実行経路は正規化済みの値を使用し、保持しなければなりません。不正な文字列値は即時に失敗させてください。レガシー別名は追加しないでください。

提出された finding を既存の family 記録に照らして裁定してください。標準の review-resolution レポートの後に、次の形式の最終行を正確に1行出力してください。

`JUDGEMENT: candidate=ARCH-NEW-channel-normalization-L2; decision=<merge|separate>; target_family=<family ID>`
