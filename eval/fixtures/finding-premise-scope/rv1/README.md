# sales-report

社内の営業データを集計して CSV を出力する CLI。各自の端末で、自分のアカウントで実行する。

```
sales-report run [--config report.config.json] [--out report.csv]
```

- 設定ファイル `report.config.json` には、集計の対象期間、部署、社内 API の接続先と `api_token`（各自が発行した個人用トークン）を書く。
- 集計中は、OS の一時ディレクトリの下に実行者だけが読み書きできる作業ディレクトリ（`fs.mkdtemp`）を作り、終了時に削除する。
- 出力は集計値だけの CSV。作業ディレクトリの内容は外部へ送らない。
