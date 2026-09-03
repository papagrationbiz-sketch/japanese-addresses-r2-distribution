# Manifest and version operations

R2直下の `manifest.json` がcurrent pointerである。データ本体はversion prefixへ先に配置し、公開後は上書きしない。

## Schema v1

- `schemaVersion`: `1` 固定
- `current`: 通常経路が参照するversion ID
- `previous`: 直前のcurrent。初回は `null`
- `updatedAt`: pointer更新時刻
- `versions`: version IDとprefixの対応
- `publishedAt`: prefixを配置した時刻
- `sourceUpdatedAt`: upstreamデータ時刻（判明時のみ）
- `coverage`: `national`または`municipalities`。省略時はunknownであり、全国配信とは推測しない
- `integrity`: 後方互換のためschema上はoptionalなSHA-256 inventory契約。新規national versionでは必須。`algorithm`は`sha256`、`inventoryPath`はversion prefix相対の安全なpath、`inventorySha256`はinventory JSON自身の64桁lowercase hex、`fileCount`は正の安全整数、`totalBytes`は非負の安全整数。

version IDは英数字、`.`、`_`、`-`だけ。prefixは安全な相対pathだけ。municipalityは`prefecture/municipality`形式で重複不可。

## 切替、rollback、prune

新prefixを検証してからmanifestへregisterし、`switch`でcurrentを変更する。固定version URLで確認し、問題があれば`rollback`する。検証成功後、`prune`はcurrentとpreviousを保持したまま、previousより古いversion metadataだけを除去する。R2 prefixの削除もcurrent/previousを保持し、older prefixだけをmanifestから切り離した後に行う。previousがnullの場合は安全のためcleanupしない。

`register`のcoverageは明示指定する。省略時はunknownであり、nationalを暗黙設定しない。

```sh
npm run manifest -- validate docs/examples/manifest.json
npm run manifest -- register /path/to/manifest.json v2026-10 versions/v2026-10 2026-10-01T00:00:00.000Z --coverage national --integrity-path _integrity/sha256.json --integrity-sha256 <64-lowercase-hex> --integrity-file-count <positive-int> --integrity-total-bytes <nonnegative-int>
npm run manifest -- register /path/to/manifest.json v2026-10 versions/v2026-10 2026-10-01T00:00:00.000Z --coverage municipalities --municipalities-file /path/to/municipalities.json
npm run manifest -- switch /path/to/manifest.json v2026-10
npm run manifest -- rollback /path/to/manifest.json
npm run manifest -- prune /path/to/manifest.json
npm run manifest -- retired-prefixes /path/to/manifest.json /tmp/retired-prefixes.txt
```

`npm run inventory -- generate <version-root> <inventory-file>` は`api/`配下のregular fileをpath順にstreaming SHA-256計算し、決定的なJSON inventoryを生成する。`verify`は欠落、余分、size/hash不一致を拒否する。inventory自身は入力対象外で、生成・upload後にclean temporary directoryへdownloadして再検証する。

municipalities fileはJSON配列または`{"municipalities":[...]}`形式。nationalを指定する場合は、生成と全量validatorが成功したworkflowだけに限定する。

## 配信経路

```text
/manifest.json
/versions/{version}/api/ja/...
```

Custom Domainの静的配信ではmanifestと固定version経路を主契約とする。current `/api/ja...` 経路、Rangeの400応答、Cache APIのpartial再構成はlegacy Data Worker限定である。固定version経路はimmutableで返す。legacy Workerのcache keyにはorigin、version、object key、start、endを含める。

公開確認は`npm run smoke -- <PUBLIC_BASE_URL> <expected-version>`で行う。manifestの再検証可能なCache-Control、固定`/versions/{id}/api/ja.json` GET、`bytes=0-0`の206、Content-Range、Content-Length、ETag、immutable Cache-Controlを、住所文字列をrequestへ含めず検査する（Range確認はlegacy Worker経路でも有効）。R2容量・生成時間・download再検証時間は環境とupstream量に依存するため断定せず、実行前にinventoryの`fileCount`/`totalBytes`、runner空き容量、timeoutを確認する。
