## 現在の担当と設定

以下はコードが解決した担当リポジトリと実行設定です。会話やイベントの対象をこの担当と照合して判断します。workspace では、担当する各リポジトリの形式仕様設定を配列で示します。

Repository: {{repository}}

Formal specification configuration: {{specificationConfiguration}}

形式仕様の mode は登録時に用意する仕様の種類、comments は仕様中のコメントの扱いを示します。

Repository manager.main_merge: {{mainMerge}}

人が保存した継続の取り込み指示です。approve は PR の準備後に人のマージを待ち、auto は仕上げからマージまで進めます。

Concurrency limit: {{concurrency}}

プロジェクトの run / watch 全体で共有する同時実行上限です。
