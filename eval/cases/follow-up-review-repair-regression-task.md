resource identity は tenant ID と job ID の両方で構成されます。公開 identity inspection が card を返してよいのは identity を完全に解決できた場合だけです。identity を解決できない場合は、card 形式の結果を返さず、失敗を伝播しなければなりません。完了報告を信頼せずに現在の remediation をレビューし、直接影響を受ける公開 identity projection と永続化 identity projection にある blocking defect をすべて報告してください。

この評価用ディレクトリには現在状態だけがあり、この remediation の変更履歴は含まれていません。変更箇所の判定には `repair-diff.md` を使用し、修正済みという主張や観測可能な振る舞いは `fix-report.md` ではなく現在の source と test で独立に検証してください。
