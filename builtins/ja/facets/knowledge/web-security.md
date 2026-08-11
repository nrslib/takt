# Web セキュリティ知識

HTTP とブラウザ状態を扱う境界をレビューする。

- 認証、認可、session cookie、CSRF、CORS、origin 検証
- URL、header、body、redirect、upload、content-type の検証
- DOM injection、template escaping、browser storage、client/server の信頼境界
- SSRF、open redirect、cache の混同、cross-origin の情報露出

各指摘を実在する web の入口またはブラウザ向けデータフローに結び付ける。非 web の設定やローカル専用コードから web 脆弱性を推測しない。
