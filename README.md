# japanese-addresses-r2-distribution

Cloudflare R2（本番はR2 Custom Domainの静的配信を既定）で、バージョン付き・地域分割の日本住所データを配信するための公開基盤。
住所文字列の正規化やジオコーディングは含めず、manifest と R2 object の配信に責任を限定する。
端末側のキャッシュポリシーや永続化実装も含めず、クライアントがこの配信契約を利用するための仕様だけを提供する。

## 構成

本番既定構成は、R2 Custom Domainからの静的配信である。Data Workerは、Range/CORSなどのlegacy互換が必要な場合だけ任意で前段に置く。

```text
client -> R2 Custom Domain -> ADDRESS_DATA (R2)
legacy client -> Data Worker -> ADDRESS_DATA (R2)
```

Worker-to-Worker 構成は将来の運用レイヤーでService Bindingを追加できる。公開URL経由のWorker間fetchは既定にしない。

## 配信契約

`/manifest.json` が current version の唯一のポインタになる。

```text
/manifest.json
/versions/{version}/api/ja/...            固定version（静的配信の主契約）
```

Custom Domainの静的配信では、manifestと固定 `/versions/{version}/...` URLを主契約とする。`/api/ja...` のcurrent短期再検証、Rangeの400応答、Cache APIのpartial再構成はlegacy Data Workerを使う場合だけの互換機能である。固定versionはimmutable cache headerを付ける。

各versionの `api/...` shardは、SHA-256 inventory（sorted JSON）でfile count・total bytes・各file hashを記録し、upload後に再検証する。既存manifestとの後方互換上はoptionalだが、新規national versionでは必須とする。inventory自身は入力shardに含めない。

manifest schema、切替、rollback、pruneの規則は [`docs/manifest.md`](docs/manifest.md) を参照。
全国生成と公開は [`docs/operations/update-workflow.md`](docs/operations/update-workflow.md)、利用側への段階導入は [`docs/operations/consumer-rollout.md`](docs/operations/consumer-rollout.md) を参照。

## 開発

```sh
npm ci
npm test
npm run typecheck
npm run build
npm run types
```

`npm run types` は現在の `wrangler.jsonc` から `worker-configuration.d.ts` を生成する。R2 bucket名は [`wrangler.jsonc`](wrangler.jsonc) の placeholder を、各環境のローカル設定またはCI設定で置き換える。実値、Secrets、住所データはGitへ追加しない。

データ生成と公開は [`build-address-data.yml`](.github/workflows/build-address-data.yml) を手動実行し、更新監視は [`upstream-monitor.yml`](.github/workflows/upstream-monitor.yml) で行う。build後はcurrent+previousを保持する。下流の受入確認後、[`finalize-release.yml`](.github/workflows/finalize-release.yml)を明示確認付きで実行し、previousより古いprefixだけをcleanupする。manifest操作は `npm run manifest`、inventory生成・検証は `npm run inventory`、公開契約の静的確認は `npm run smoke` で実行できる。公開済みversionの住所精度は `npm run accuracy -- <公開base URL> <version> [出力ファイル]` で確認する。これは公開経路から都道府県ごとに1件（＋構造的な固定ケース）を決定的に抽出し、各町字の代表点を国土地理院の住所検索結果とhaversine距離で比較する。抽出は seed 固定のため再実行しても同じ住所を照合する。coverage省略時はunknownであり、nationalとは解釈しない。公開前にはupstreamのexact commitを指定し、生成結果と出典をレビューする。

smoke確認では公開base URLをhost root（path/query/fragmentなし）で渡し、期待するcurrent versionも指定する。

生成データの出典と再配布条件は [`DATA.md`](DATA.md)、セキュリティ境界は [`SECURITY.md`](SECURITY.md) を参照。
