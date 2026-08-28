```markdown
# 修正計画

## 結果: 修正計画確定 / タスク全体の再計画が必要

## 指摘と修正単位の対応
各 accepted finding と修正単位について、根因、境界、対象経路を含む evidence inventory を維持してください。各 entry には source file path、symbol / function / helper、存在する場合は関係する caller → callee を明記し、caller 関係がない場合はその旨と direct production entry の根拠を示してください。これらの具体的な参照を伴わない意味要約は evidence とみなしません。
| finding ID / 出典 | 修正単位 | 根拠 | 受入条件 |
|-------------------|----------|------|----------|
| {ID とレポート名} | {同じ原因と完了条件を持つ修正の名前} | {source file path + symbol/function/helper + 関係する caller → callee、または関係がない場合の direct production-entry 根拠} | {観測可能な完了条件} |

## 修正単位
| 修正単位 | 原因 | 守る条件 | 関係する経路 | 変更対象 | 変更しない範囲 |
|----------|------|----------|----------------|----------|----------------|
| {名前} | {確認した原因と、否定した主な別原因} | {外部から観測できる条件} | {source file path、symbol/function/helper、caller → callee の実在順を含む、実在する top-level production entry から全ての shared/prior、値に影響する stage、effectful stage、利用箇所、出力までの経路} | {必要な最小変更} | {別の契約、周辺作業、不要な方式変更} |

## 入力・状態・経路の確認表
影響経路監査の結果を、適用される経路ごとに1行ずつ記録してください。概要や「全consumer」「同上」で複数の経路を省略してはいけません。適用可能な各 field / member / variant（edit か verify-only かを問わない）に stable atomic element ID を付けてください。同じ path を別行にするか、同じ行の中で各 ID の反証を明示し、具体的な baseline の入力・state と、baseline からその要素だけが変わる単独の sentinel mutation を別々に記録します。他の入力・state・要素は固定し、canonical top-level production entry を通して、その ID 固有の mutated terminal / artifact の観測結果を記録してください。baseline だけの確認や preservation だけの記述、境界だけで行うテスト、複数要素を同時に変更する mutation、単なる列挙だけでは要件を満たしません。正本が要素を変更不能と定める場合は isolated copy または同じ consumer boundary への等価な入力を使い、mutation が unsupported なら正本とコードの根拠付きでのみ除外し、baseline の確認で代用してはいけません。

入口から terminal までの経路には、実在する全ての file / module と function / helper を caller → callee の実行順で記載し、独立した sibling branch は top-level entry から個別に追跡してください。必須の file、asset、configuration reference には unavailable または omitted の反証と失敗伝播を記録し、placeholder、delimiter、その他の transform token が実在する場合は data sentinel とは別に token の欠落・変更も記録します。値に影響する effectful な中間 stage、特に persistence、write、dispatch には、適用可能な bypass / omission mutation または boundary spy と、具体的な terminal / artifact の欠落・変化を記録してください。正本とコードに根拠のある有限な state / stage だけを扱い、全 stage / state の直積は要求しません。

全ての canonical row と evidence-path entry は、実在する top-level production entry から開始し、terminal より前に実行される shared / prior、値に影響する stage、effectful stage を実行順で含めてください。defining source や direct consumer から途中開始してはいけません。各 sibling terminal について entry からの完全な prefix を再記載し、「同上」などで省略しないでください。prefix stage のいずれかを省略した場合は計画を確定できず、最終 reconciliation を失敗とします。

| 修正単位 | Atomic Element ID | 正本と根拠 | baseline の具体的な入力・状態 | 単独要素 mutation | 入口から terminal までの経路 | 経路上の扱い | 実装上の制約 | baseline の期待結果 | mutation 後の terminal / artifact 観測 | 反証方法 |
|----------|------------------|----------------|-----------------------------|------------------|--------------------------------|--------------|--------------|-------------------|--------------------------------------|----------|
| {修正単位} | {stable atomic element ID} | {有限集合・状態・不変条件を定める source file path、symbol/function/helper、caller → callee の根拠} | {具体的な baseline の入力または状態} | {異なる単独要素 sentinel mutation。他の入力・state・要素は固定} | {実在する top-level production entry → 全ての shared/prior、値に影響する stage、effectful stage → function/helper → consumer → terminal の実行順。各 sibling について完全な prefix を再記載} | {各箇所の edit / migrate-remove / verify-only} | {守る契約、または「なし」の根拠} | {baseline の観測可能な結果} | {mutation 後の terminal または artifact の具体的な観測} | {違反時に失敗するテスト、再現、検索、またはコード追跡} |

## 実施順序
| 順序 | 修正単位 | 作業 | 依存先 | 完了条件 |
|------|----------|------|--------|----------|
| {N} | {名前} | {境界変更 / 利用側移行 / 旧経路削除 / 局所修正} | {先行作業またはなし} | {コードと観測結果で確認できる条件} |

## 確認方法
| 修正単位 | 確認する経路・状態 | 成立例 | 失敗例・境界値 | 確認方法 |
|----------|--------------------|--------|----------------|----------|
| {名前} | {影響を受ける実在経路または状態} | {期待どおり成立する具体例} | {違反を検出できる具体例} | {テスト、再現、検索、コード追跡} |

## 再計画事項
- {なし、または原因・要求・修正範囲を確定できない根拠と必要な判断}
```

- 同じ原因、守る条件、受入条件を持つ指摘は1つの修正単位にまとめる
- 各修正単位について、報告された場所だけでなく同じ原因で影響を受ける実在経路を計画時に確認する
- 実在しない経路や関係のない仕組みを網羅項目として追加しない
- 1件の不足だけで計画を確定せず、対象となる全 finding ID を対応付ける
