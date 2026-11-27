# 実装報告

- src/receiver.mjs を追加した。署名を検証し、受付番号の形式を確かめてから、添付ファイルを `storage/attachments/<受付番号>/<ファイル名>` に保存する。
- test/receiver.test.mjs に、保存先、署名の拒否、受付番号の拒否のテストを追加した。`node --test` で 3 件成功。
