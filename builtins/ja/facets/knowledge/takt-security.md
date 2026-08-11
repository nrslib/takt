# TAKT固有のセキュリティ知識

TAKT固有の境界を対象にレビューする。

- workflow と facet の設定が schema、正規化、preview、doctor の整合性を保つこと
- provider、model、selector、session、resume、occurrence の識別情報が workflow や parallel 子の境界を越えて混線しないこと
- permission、allowed tools、worktree、subprocess、リポジトリ変更が step の契約範囲に収まること
- snapshot、retry、resume の状態が所有者を保ち、別の step や親 occurrence を再利用しないこと
- selector と runner のエラーが別 workflow や provider への暗黙のフォールバックにならず、所有境界で停止すること

対象コードがその境界に到達していない限り、web、CLI、依存関係の一般的なチェックリストを TAKT 固有の根拠として扱わない。
