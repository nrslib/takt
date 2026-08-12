# ローカルプロセス・ファイルシステム境界のセキュリティ知識

## 適用条件

低信頼のCLI入力、設定、環境変数、repository内ファイルが、process起動、filesystem操作、またはローカル権限へ到達する変更に適用する。固定された内部入力だけを扱い、信頼境界を変えない変更には適用しない。

## Process起動

実行ファイル、引数、environment、working directoryを別々の境界として追跡する。`spawn`か`exec`かというAPI名だけで判定せず、低信頼の値がshell構文や実行対象として再解釈されるかを確認する。

| 基準 | 判定 |
|------|------|
| 低信頼の値をshell command文字列へ連結する | REJECT |
| 低信頼の値が、宣言された信頼レベルや権限を越える実行ファイル、loader、plugin、またはcode search pathを選べる | REJECT |
| 固定した実行ファイルへ引数配列で渡し、shellで再解釈しない | OK。ただし引数自体が危険な機能を選べないか確認する |
| executable、引数、environment、cwdを契約に沿って個別に制約する | OK |

```typescript
// NG: shellが入力を構文として再解釈する
exec(`tool --input ${userInput}`)

// OK: 実行対象を固定し、検証済みの値を1つの引数として渡す
spawn('tool', ['--input', validatedPath], { shell: false })
```

## Filesystem containment

文字列に`../`があるか、prefixが一致するかだけでは包含を保証できない。正規化後の相対関係を確認し、既存ファイルを扱う境界でsymlinkを許容しない場合はcanonical pathも確認する。

| 基準 | 判定 |
|------|------|
| 低信頼のpathが許可root外の読込・書込・削除へ到達する | REJECT |
| 文字列prefixの一致だけでroot内と判定する | REJECT |
| 正規化したrootからの相対pathが外へ出ないことを確認する | OK |
| symlinkを含む既存pathでは、要求する境界に応じてcanonical pathを確認する | OK |

```typescript
// lexical containmentのみ。symlinkを許容しない既存pathではrealpathも比較する
const root = path.resolve(baseDir)
const target = path.resolve(root, userInput)
const relative = path.relative(root, target)
if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
  throw new Error('Invalid path')
}
```

## ローカル設定とcredential

repositoryや作業directoryから読まれる設定は、利用者のglobal設定や実行時credentialと同じ信頼レベルとは限らない。低信頼の設定がsandbox、tool、network、出力先を広げないことを確認する。credentialや機密値はcommand引数、log、error、生成物へ残さない。
