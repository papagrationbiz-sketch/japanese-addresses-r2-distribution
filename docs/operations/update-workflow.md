# Update workflow

## 監視

`upstream-monitor.yml` は月次で `geolonia/japanese-addresses-v2` の指定refと公開データ時刻を確認する。差分があれば公開Issueを1件作成する。監視は通知だけで、R2やmanifestは変更しない。

同梱baselineは2026-09-02取得分（upstream commit `521f6130110dabcc8d6d12e89606f0515c217eed`、`meta.updated` `1735102668`）である。公開時は必ずレビュー済みのexact commitを指定する。

## 生成と二段階公開

`build-address-data.yml` は `workflow_dispatch` でのみ起動する。GitHub Environment `r2-production` の承認ルールを設定してから利用する。

1. レビュー済みのupstream exact commit（40桁lowercase SHA）を`upstream_ref`へ指定し、upstreamをforkせずcloneしてdetach checkoutする。fetch後のHEADが入力SHAと完全一致することを検証する。
2. upstream directoryだけをbind mountした非root `node:22-bookworm`コンテナ内で`npm ci && npm run run:all`を実行する。root checkout、root `node_modules`、credentialsはコンテナへmountせず、R2 Secretsも渡さない。
3. `scripts/validate-dataset.mts`で47都道府県、自治体、町字range、object size整合性を確認する。
4. validator成功後、`scripts/inventory.mts`で`api/...`全regular fileのdeterministic SHA-256 inventoryを生成し、指定version prefixへimmutable uploadする。
5. clean temporary directoryへ全version dataとinventoryをdownloadし、inventoryのfile count・total bytes・各hashを再検証する。失敗時はmanifestを変更しない。
6. manifestへregisterする。全量検証済みのこのworkflowだけが`--coverage national`を明示する。
7. `activate=false`なら登録だけ、`activate=true`ならcurrentを切り替える。
8. activate時は`npm run smoke -- <PUBLIC_BASE_URL> <VERSION>`でmanifestのcurrent一致、固定GET、single Range、headersを確認する。これはR2 Custom Domain直配信とlegacy Workerの両方に適用する。
9. build workflowはcurrentとpreviousを保持して終了し、rollback windowを残す。

manifestのread-modify-write競合を防ぐため、buildはregister/upload直前にR2のmanifestを再取得し、最初にvalidateしたローカルbyte列と`cmp`で一致確認する。不一致ならmanifestを変更・uploadせず停止する。

下流の受入確認完了後、`finalize-release.yml`を別途手動実行する。`expected_current`と確認文字列`DELETE_OLDER_THAN_PREVIOUS`を入力し、GitHub Environment承認を通す。finalizeはmanifest取得・validate、current一致、公開manifest/fixed root smokeを実施する。prune/upload直前にもR2 manifestを再取得して初回取得時のbyte列と比較し、不一致ならpruneも削除も行わない。一致した場合だけmanifestをpruneし、currentとpreviousを保持してolder prefixだけを削除する。previousがnullならcleanupしない。

生成途中のversion prefixには`_build.json` markerを置く。同じversion prefixにobjectが既にある場合、markerのversion、upstream exact commit、sourceUpdatedAt、inventory SHA-256、file count、total bytesが今回と完全一致するときだけ全objectをuploadし直す。不一致またはmarker欠落の場合は停止する。manifestに登録済みのversionは常に再利用しない。

buildのsmokeまたは公開検証が失敗した場合、旧manifestを復元し、previous prefixを保持する。finalizeのsmoke失敗時はpruneも削除も行わない。prune後の削除に失敗した場合もmanifestはcurrentとpreviousを保持したままなので、残ったolder prefixはR2の権限と対象キーを再確認したうえで、別の保守処理で個別に削除する。削除対象がない場合は安全終了する。

## 設定

### 初回全国生成の前提

- 公開repositoryのGitHub Environment `r2-production`にrequired reviewerを設定し、承認前はR2 Secretsをjobへ渡さない。
- 標準`ubuntu-latest` runnerは14 GB SSDのため、生成後の`inventory.totalBytes`に1 GiBを加えた空き容量を、元データ削除後・再download前にworkflowが検査する。満たさなければmanifestを変更せず停止する。
- job timeoutは360分。生成時間、upload時間、全量再download時間は初回runで別々に記録し、timeoutへ近づく場合はlarger/self-hosted runnerを別途承認する。
- R2権限は対象bucketのList/Get/Put/Deleteに限定する。Deleteは`finalize-release.yml`だけが、current/previous以外の検証済みprefixへ使用する。
- Custom Domainを同じCloudflare accountのzoneへ接続する。`r2.dev`は本番経路にしない。
- Cache Ruleは`/manifest.json`をbypassし、`/versions/*`だけをcache対象にする。JSON/TXTは既定でcacheされない場合があるため、固定version pathのruleを明示する。manifestをCache Everythingへ含めない。
- Native clientだけならCORSは不要。browser clientも提供する場合は、許可origin/method/headerを別途R2 CORSへ設定する。

Custom Domain、DNS、Cache Rule、CORS、Secrets、全国uploadは外部状態を変更するため、対象domain、公開範囲、費用影響、rollbackを確認してから実行する。

GitHub Environment variables:

- `R2_BUCKET`: R2 bucket名
- `R2_ENDPOINT`: S3互換R2 endpoint（`https://host`形式）
- `PUBLIC_BASE_URL`: activate時必須の公開R2 Custom Domain base URL（legacy Data Workerを使う場合はそのURL）

GitHub Secrets（値はworkflowへ直書きしない）:

- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`

R2のendpoint、bucket、公開URL、認証値はこのリポジトリへ書かない。R2 access keyはmanifest read/write、対象prefix upload、検証済みretired prefix deleteだけの最小権限にする。workflow inputのversion/refは正規表現で検証し、AWS/Git/curlにはquote済み文字列で渡す。upstream clone、生成、validatorのstepにはR2 Secretsを渡さない。

## M6受入証跡

外部runごとに、秘密情報や住所本文を含めず次を保存する。

- workflow run URL、reviewer、開始／終了時刻、各主要step所要時間
- upstream exact commit、source timestamp、version ID
- validator summary、inventory SHA-256、file count、total bytes
- upload後の全量再download検証成功
- 公開manifestのcurrent/previous、固定URL、GET/Range status、Content-Range、Content-Length、ETag、Cache-Control
- 切替、previousへのrollback、再切替の結果
- cleanup前後のmanifest。current/previousが保持され、削除対象がolderだけであること
- 全国versionに対する精度suite、latency。Custom Domain直配信ではWorker CPUを使用しないため、CPU証跡はlegacy Workerを残す場合だけ取得する

consumer rolloutへの引継ぎは[`consumer-rollout.md`](consumer-rollout.md)を参照する。
