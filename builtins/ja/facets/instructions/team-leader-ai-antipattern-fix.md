AI Review の指摘を、競合しない修正パートへ分解してください。親 Team Leader 自身はツールを使わず、以下で engine が渡す前ステップの応答だけで分解します。

**AI Review 応答:**
{previous_response}

**分解の要件:**
- 指摘ごとに対象ファイル、参照専用ファイル、実施する修正、完了基準を part instruction に明記する
- 同じファイルを複数パートへ割り当てない
- 同じバッチ内の各 part は単独で実行可能にし、テスト・ビルドは修正結果がそろった後の feedback batch でのみ要求する
- 指摘の確認・直接修正・検証を member の part instruction に含める
- レポート本文にない事実を補完しない。不足があれば確認専用 part を作る
