# Project tool service

プロジェクト内の資料を公開するツールです。セッションの権限、操作名、対象パスを確認します。すべての拒否応答は `isError: true` と空でないテキストの理由を含む必要があります。理由のない拒否は受入条件を満たしません。

This tool publishes documents within a project. It checks the session permissions, operation name, and target path. Every rejection response must include `isError: true` and a nonempty textual reason. A rejection without a reason does not meet the acceptance conditions.

`node --test` で公開と拒否のテストを実行できます。
Run `node --test` to test publishing and rejection behavior.
