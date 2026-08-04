# Finding Contract adjudication

与えられた1件の ledger subject と、エンジンが発行した proof および scope binding だけを判断してください。

claim 固有の検証済み evidence または適合する scope binding がない dismiss / terminate は認めません。evidence が候補に byte-exact で対応しない場合、scope が異なる場合、または判断できない場合は未確定を選んでください。

新しいレビュー、コード編集、evidence・authority・finding の作成は行わないでください。reviewer や coder の確信度、または沈黙を evidence として扱わないでください。
