**Contract family core**

contract family は、次の identity が同じ経路の集合です。

- 観測可能な不変条件
- authoritative owner または source of truth
- 同じ原因で変更される理由
- 利用者、外部境界、または terminal state に現れる結果

実在する経路を `owner / definition -> producer -> transform / normalize / validate -> persist / transfer / restore -> consumer -> exception / retry / fallback / parallel -> terminal / API / observability` として記述してください。該当しない段階を作らないでください。

確認した経路は次のいずれかに分類してください。

- `participates`: family の不変条件を成立させる経路
- `preserved`: family に接続するが、今回の契約では変更せず保持する経路
- `outside`: identity、owner、変更理由のいずれかが異なる別 family

この core は探索、finding、編集、判定、完了を許可しません。権限と手順は、この core を含む role instruction と有効な policy に従ってください。
