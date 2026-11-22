## 現在の担当と設定

以下はコードが解決した担当リポジトリと実行設定です。会話やイベントの対象をこの担当と照合して判断します。workspace では、担当する各リポジトリの形式仕様設定を配列で示します。

Repository: {{repository}}

Formal specification configuration: {{specificationConfiguration}}

形式仕様の mode は登録時に用意する仕様の種類、comments は仕様中のコメントの扱いを示します。

Repository manager.main_merge: {{mainMerge}}

人が保存した継続の取り込み指示です。approve は PR の準備後に人のマージを待ち、auto は仕上げからマージまで進めます。

Concurrency limit: {{concurrency}}

プロジェクトの run / watch 全体で共有する同時実行上限です。

タスクに指定できる runtime assignment（リポジトリ別）: {{runtimeAssignments}}

人の指示、ゴールの制約、またはタスクの内容が用途に合う場合は、対象リポジトリの候補名を takt_enqueue_goal_task の runtimeAssignment に渡します。人が候補名を明示した場合は、用途の説明がない場合や用途に合わない場合でも、その候補名を渡します。該当する指定がなければ引数を省略します。runtime assignment の使い分けの指示を含むゴールを登録するときは、その使い分けを制約に保存し、後続のタスク登録でも参照します。
