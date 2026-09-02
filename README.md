# japanese-addresses-r2-distribution

Cloudflare Workers と R2 で、バージョン付き・地域分割の日本住所データを配信するための公開基盤。
住所文字列の正規化やジオコーディングは含めず、manifest と R2 object の配信に責任を限定する。
端末側のキャッシュポリシーや永続化実装も含めず、クライアントがこの配信契約を利用するための仕様だけを提供する。

## 構成

既定構成は、単一の Data Worker と R2 binding である。

```text
client -> Data Worker -> ADDRESS_DATA (R2)
```

Worker-to-Worker 構成は将来の運用レイヤーでService Bindingを追加できる。公開URL経由のWorker間fetchは既定にしない。

## 配信契約

`/manifest.json` が current version の唯一のポインタになる。

```text
/manifest.json
/api/ja.json                              current
/api/ja/{prefecture}/{municipality}.json  current
/versions/{version}/api/ja/...            固定version
```

固定versionは immutable cache header、current経路は短い再検証期限で返す。Range は `bytes=start-end` の単一明示範囲だけを受け付け、suffix・open-ended・multi-range は `400` とする。Cache APIへは内部 `200` として保存し、公開時に `206` へ再構成する。version、object key、範囲をすべてCache keyへ含める。

manifest schema、切替、rollback、pruneの規則は [`docs/manifest.md`](docs/manifest.md) を参照。

## 開発

```sh
npm ci
npm test
npm run typecheck
npm run build
npm run types
```

`npm run types` は現在の `wrangler.jsonc` から `worker-configuration.d.ts` を生成する。R2 bucket名は [`wrangler.jsonc`](wrangler.jsonc) の placeholder を、各環境のローカル設定またはCI設定で置き換える。実値、Secrets、住所データはGitへ追加しない。

データ生成と公開は [`build-address-data.yml`](.github/workflows/build-address-data.yml) を手動実行し、更新監視は [`upstream-monitor.yml`](.github/workflows/upstream-monitor.yml) で行う。build後はcurrent+previousを保持する。下流の20〜50件精度確認後、[`finalize-release.yml`](.github/workflows/finalize-release.yml)を明示確認付きで実行してprune・retired prefix削除を行う。manifest操作は `npm run manifest` で実行できる。coverage省略時はunknownであり、nationalとは解釈しない。公開前にはupstreamのexact commitを指定し、生成結果と出典をレビューする。

生成データの出典と再配布条件は [`DATA.md`](DATA.md)、セキュリティ境界は [`SECURITY.md`](SECURITY.md) を参照。
