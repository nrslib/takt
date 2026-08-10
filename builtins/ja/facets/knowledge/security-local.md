# CLI・ローカル実行セキュリティ知識

## 適用条件

CLI、ローカルagent、shell/process起動、ファイルシステム、project/user設定、plugin、provider、ローカルIPCを変更する場合に適用する。remote APIやbrowser境界だけの変更には適用しない。

## ローカルtrust boundary

同一OS userが所有するproject設定、user設定、cache、実行履歴を同じtrust levelとして扱う設計では、同一userによる改変だけを根拠に脆弱性としない。別user、低信頼repository、download済みartifact、外部provider出力が高信頼側へ越える経路は別の境界として確認する。

| 状況 | 判定 |
|------|------|
| documentedなproject/user設定の優先順位 | 通常はOK |
| 明示的selectorで同じtrust levelの定義を選択 | 通常はOK |
| 低信頼repositoryの内容がuser-global commandやcredentialを変更する | 具体経路があればREJECT候補 |
| provider出力が検証なしでshell、path、設定へ使われる | 到達経路と影響を確認する |

## Command injection

- 低信頼入力をshell command文字列へ連結する到達可能な経路 → REJECT
- shellを介さずargument配列を渡し、入力がcommandやoption境界を変更できない → OK

```typescript
// NG
exec(`tool ${userInput}`)

// OK
execFile('tool', [validatedInput])
```

shell APIの使用だけではREJECTにしない。command、argument、environment、working directoryのうち攻撃者が制御できる要素を確認する。

## ファイル操作・path traversal

- 低信頼pathが許可rootの外へ解決される経路 → REJECT
- `..`、absolute path、symlinkを含む実際の解決後pathを検証していない経路 → REJECT
- pathに入力値が含まれるだけではREJECTにしない。許可rootと解決後pathの検証を確認する

```typescript
const safePath = path.resolve(baseDir, userInput)
if (!safePath.startsWith(`${path.resolve(baseDir)}${path.sep}`)) {
  throw new Error('Invalid path')
}
```

## Plugin・provider・外部tool

plugin、provider、外部toolは、それぞれの導入元と実行権限に基づいてtrust levelを判断する。悪意あるproviderや改変済みpluginを前提にするだけでなく、その出力が既存境界を越えて新しい操作を可能にする経路を確認する。
