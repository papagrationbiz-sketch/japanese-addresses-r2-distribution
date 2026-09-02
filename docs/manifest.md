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

version IDは英数字、`.`、`_`、`-`だけ。prefixは安全な相対pathだけ。municipalityは`prefecture/municipality`形式で重複不可。

## 切替、rollback、prune

新prefixを検証してからmanifestへregisterし、`switch`でcurrentを変更する。固定version URLで確認し、問題があれば`rollback`する。検証成功後、`prune`でpreviousとretired version metadataを削除する。R2 prefixの削除はmanifestをpruneして公開URLから切り離した後に行う。

`register`のcoverageは明示指定する。省略時はunknownであり、nationalを暗黙設定しない。

```sh
npm run manifest -- validate docs/examples/manifest.json
npm run manifest -- register /path/to/manifest.json v2026-10 v2026-10 2026-10-01T00:00:00.000Z --coverage national
npm run manifest -- register /path/to/manifest.json v2026-10 v2026-10 2026-10-01T00:00:00.000Z --coverage municipalities --municipalities-file /path/to/municipalities.json
npm run manifest -- switch /path/to/manifest.json v2026-10
npm run manifest -- rollback /path/to/manifest.json
npm run manifest -- prune /path/to/manifest.json
```

municipalities fileはJSON配列または`{"municipalities":[...]}`形式。nationalを指定する場合は、生成と全量validatorが成功したworkflowだけに限定する。

## 配信経路

```text
/manifest.json
/api/ja.json
/api/ja/{prefecture}/{municipality}.json
/versions/{version}/api/ja/...
```

current経路は短い再検証期限、固定version経路はimmutableで返す。Rangeは`bytes=start-end`の単一明示範囲だけを受け付け、不正値はR2へ転送せず400を返す。Cache APIへはpartial responseを直接保存せず、内部200に範囲メタデータを付けて保存する。cache keyにはorigin、version、object key、start、endを含める。
