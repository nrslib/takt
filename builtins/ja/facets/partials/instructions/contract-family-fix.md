**Contract family role: `fix`**

{{include:instructions/contract-family-core}}

accepted family ごとに、編集前に全 graph を再構築して `participates / preserved / outside` を確定してください。指摘が局所的でも、共通 owner とすべての `participates` 経路を修正し、`preserved` を維持してください。

編集後は別名の再構築、直書き、旧 helper、未移行 consumer、片側更新を再検索し、残存を解消してください。
