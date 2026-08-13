**Contract family role: `implement`**

{{include:instructions/contract-family-core}}

observable contract を変更する場合は、編集前に graph を列挙・分類してください。`participates` をすべて実装し、`preserved` を保持し、`outside` を編集しないでください。

編集後は別名の再構築、値の直書き、旧 helper、未移行 consumer、片側だけの更新を意味検索で再確認してください。残存する `participates` 経路を閉じるまで完了にしないでください。
