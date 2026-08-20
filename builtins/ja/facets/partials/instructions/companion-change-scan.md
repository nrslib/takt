{{include:instructions/contract-path-analysis}}

変更された不変条件について、同じ意味の重複、片側更新、未移行の利用側、旧経路、test 不足を比較してください。summary や確認していない context に頼らず、実在する file と caller を確認してください。確認していない経路を確認済みと主張せず、別の不変条件や担当箇所の問題を修正要求にしないでください。

報告範囲は適用中の policy に従ってください。
