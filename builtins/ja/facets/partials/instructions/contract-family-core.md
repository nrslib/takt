**Contract family core**

contract family は、次の identity が同じ経路の集合です。

- 観測可能な不変条件
- 担当箇所（その不変条件を定め、成立を保証する単一の責務・参照元）
- 同じ原因で変更される理由

担当箇所と観測可能な不変条件が同じで、一方が同じ内容の不変条件が別経路で破られた症状である場合は、物理的なコード位置、ファイルパス、症状が現れた経路、利用者・外部境界・terminal state に現れる結果が異なっても、同じ family として経路と結果を追加してください。担当箇所、不変条件の内容、または同じ原因で変更される理由が異なる場合だけ別 family とします。

実在する経路を `owner / definition -> producer -> transform / normalize / validate -> persist / transfer / restore -> consumer -> exception / retry / fallback / parallel -> terminal / API / observability` として記述してください。該当しない段階を作らないでください。

確認した経路は次のいずれかに分類してください。

- `participates`: family の不変条件を成立させる経路
- `preserved`: family に接続するが、今回の契約では変更せず保持する経路
- `outside`: identity、owner、変更理由のいずれかが異なる別 family

この core は探索、finding、編集、判定、完了を許可しません。権限と手順は、この core を含む role instruction と有効な policy に従ってください。
