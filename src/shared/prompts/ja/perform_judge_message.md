{{phaseContext}}

<!--
  template: perform_judge_message
  phase: judge (AI-based rule evaluation)
  vars: agentOutput, conditionList
  caller: structuredCaller.evaluateCondition
-->
# 判定タスク

あなたはエージェントの出力を条件セットに対して評価する判定者です。
「エージェント出力」の節を読み、最も一致する条件を判定してください。

## エージェント出力
```
{{agentOutput}}
```

## 判定基準
| # | 条件 |
|---|------|
{{conditionList}}

## 指示
判定は「エージェント出力」の節に書かれた内容だけで行い、ファイルやコードなど出力の外の資料は調べないでください。
最も一致する条件の番号のタグ `[JUDGE:N]` のみを出力してください。
それ以外は出力しないでください。
