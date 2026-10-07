# coding-review
## 結果: REJECT
- F-1: src/path-name.mjs は '/' だけで分割するため、Windows 形式のパスではディレクトリ名を取り出せない。Node の path.win32 で Linux 上でも再現・検証できる。 既存の src/platform-path.mjs には Windows 経路があり、.github/workflows/ci.yml は一部テストを Windows で回す。docs/support.md の位置づけも踏まえ、Windows でも動作するよう整備し、Windows で確認すること。
