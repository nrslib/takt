# TAKTワークフロー分析の前提

TAKTのワークフローは、step、transition、rulesと、各stepに組み込まれるfacetsで実行プロセスを構成する。

- facetsは個別に組み立てられる。あるfacetは、同じstepや別stepで使われる別のfacetの内容を暗黙には認識できない。
- 複数stepで共有する不変条件は、個別のfacetへ重複させず、ワークフロー全体へ適用されるruleに置く。
- step間の情報の引き継ぎには、前の応答または明示的なreportを使う。別stepのfacetを直接参照させない。
- routingと実行順序はワークフロー定義が所有する。特定stepだけの手順・役割・判断材料・出力構造は、対応するfacetが所有する。
- 分析では、ワークフローの構造だけでなく、各stepが実際に参照したfacetsも確認し、原因と変更先を対応付ける。
