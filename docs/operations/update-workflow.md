# Update workflow

## 監視

`upstream-monitor.yml` は月次で `geolonia/japanese-addresses-v2` の指定refと公開データ時刻を確認する。差分があれば公開Issueを1件作成する。監視は通知だけで、R2やmanifestは変更しない。

同梱baselineは2026-09-02取得分（upstream commit `521f6130110dabcc8d6d12e89606f0515c217eed`、`meta.updated` `1735102668`）である。公開時は必ずレビュー済みのexact commitを指定する。

## 生成と二段階公開

`build-address-data.yml` は `workflow_dispatch` でのみ起動する。GitHub Environment `r2-production` の承認ルールを設定してから利用する。

1. レビュー済みのupstream exact commit（40桁lowercase SHA）を`upstream_ref`へ指定し、upstreamをforkせずcloneしてdetach checkoutする。fetch後のHEADが入力SHAと完全一致することを検証する。
2. upstream directoryだけをbind mountした非root `node:22-bookworm`コンテナ内で`npm ci && npm run run:all`を実行する。root checkout、root `node_modules`、credentialsはコンテナへmountせず、R2 Secretsも渡さない。
3. `scripts/validate-dataset.mts`で47都道府県、自治体、町字range、object size整合性を確認する。
4. validator成功後、指定version prefixへimmutable uploadする。
5. manifestへregisterする。全量検証済みのこのworkflowだけが`--coverage national`を明示する。
6. `activate=false`なら登録だけ、`activate=true`ならcurrentを切り替える。
7. activate時は`PUBLIC_BASE_URL`のmanifestと固定version rootをsmoke testする。
8. build workflowはcurrentとpreviousを保持して終了し、rollback windowを残す。

manifestのread-modify-write競合を防ぐため、buildはregister/upload直前にR2のmanifestを再取得し、最初にvalidateしたローカルbyte列と`cmp`で一致確認する。不一致ならmanifestを変更・uploadせず停止する。

下流の20〜50件精度確認（Swiftクライアントおよび利用側gateway）完了後、`finalize-release.yml`を別途手動実行する。`expected_current`と確認文字列`DELETE_RETIRED`を入力し、GitHub Environment承認を通す。finalizeはmanifest取得・validate、current一致、公開manifest/fixed root smokeを実施する。prune/upload直前にもR2 manifestを再取得して初回取得時のbyte列と比較し、不一致ならpruneも削除も行わない。一致した場合だけmanifestをpruneしてretired prefixを削除する。

生成途中のversion prefixには`_build.json` markerを置く。同じversion prefixにobjectが既にある場合、markerのversion、upstream exact commit、sourceUpdatedAtが今回と完全一致するときだけuploadをresumeする。不一致またはmarker欠落の場合は停止する。manifestに登録済みのversionは常に再利用しない。

buildのsmokeまたは公開検証が失敗した場合、旧manifestを復元し、previous prefixを保持する。finalizeのsmoke失敗時はpruneも削除も行わない。prune後の削除に失敗した場合もmanifestはcurrentだけのままなので、残ったprefixはR2の権限と対象キーを再確認したうえで、別の保守処理で個別に削除する。削除対象がない場合は安全終了する。

## 設定

GitHub Environment variables:

- `R2_BUCKET`: R2 bucket名
- `R2_ENDPOINT`: S3互換R2 endpoint（`https://host`形式）
- `PUBLIC_BASE_URL`: activate時必須の公開Data Worker base URL

GitHub Secrets（値はworkflowへ直書きしない）:

- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`

R2のendpoint、bucket、公開URL、認証値はこのリポジトリへ書かない。R2 access keyはmanifest read/write、対象prefix upload、検証済みretired prefix deleteだけの最小権限にする。workflow inputのversion/refは正規表現で検証し、AWS/Git/curlにはquote済み文字列で渡す。upstream clone、生成、validatorのstepにはR2 Secretsを渡さない。
