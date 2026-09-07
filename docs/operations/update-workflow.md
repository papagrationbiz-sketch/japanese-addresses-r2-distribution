# Update workflow

## 監視

`upstream-monitor.yml` は月次で `geolonia/japanese-addresses-v2` の指定refと公開データ時刻を確認する。差分があれば公開Issueを1件作成する。監視は通知だけで、R2やmanifestは変更しない。

同梱baselineは2026-09-02取得分（upstream commit `521f6130110dabcc8d6d12e89606f0515c217eed`、`meta.updated` `1735102668`）である。公開時は必ずレビュー済みのexact commitを指定する。

## 生成と二段階公開

`build-address-data.yml` は `workflow_dispatch` でのみ起動する。GitHub Environment `r2-production` の承認ルールを設定してから利用する。

1. レビュー済みのupstream exact commit（40桁lowercase SHA）を`upstream_ref`へ指定し、upstreamをforkせずcloneしてdetach checkoutする。fetch後のHEADが入力SHAと完全一致することを検証する。
2. upstream directoryとrunnerの専用一時directoryだけをbind mountした非root `node:22-bookworm`コンテナ内で依存解決と生成を実行する。`run:01_make_prefecture_city`で全国rootを一度作った後、47都道府県コードを1つずつ`SETTINGS_JSON`の`lgCodes`へ渡して`run:02_make_machi_aza`・`run:03_make_rsdt`・`run:04_make_chiban`を順次実行する。各都道府県はfreshな一時出力directoryへ生成し、stageが成功した場合だけ対象都道府県のJSONまたは`*-住居表示.txt`・`*-地番.txt`を最終`out/api`へ反映するため、失敗途中や前回prefixの部分出力を混在させない。全47都道府県が成功してから`SETTINGS_JSON`をunsetし（後段へprefix filterを漏らさないisolation/future-proof invariant）、全国対象の`run:10_refresh_csv_ranges`と`run:99_create_stats`を実行する。`run:03_make_rsdt`と`run:04_make_chiban`だけが、`terminated`、`UND_ERR_SOCKET`、`ECONNRESET`、`ETIMEDOUT`など観測済みのbody/network一時エラーを最大3回再試行し、`SQLITE_FULL`や入力不整合など他の失敗は即時停止する。attempt開始前と失敗直後に結合用SQLite一時directoryを削除するが、attempt間は`CACHE_DIR`のdownload cacheを再利用する。生成後はroot `ja.json`のcanonical `meta.updated`を自治体JSONの生成メタデータへ反映し、upstreamの独立実行時刻差だけを解消する。step終了時の`EXIT` trapで専用一時directory（cacheを含む）をcleanupする。root checkout、root `node_modules`、credentialsはコンテナへmountせず、R2 Secretsも渡さない。
3. `scripts/validate-dataset.mts`で47都道府県、自治体、町字range、object size整合性を確認する。upstreamが町字行なしとして自治体JSONを省略する場合は、対応する住居表示・地番shardも存在しないときだけ許容し、shardが残る自治体JSON欠落は失敗にする。
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
- 全国の住居表示・地番結合は数GiBの一時SQLiteを作るため、コンテナの`TMPDIR`をrunner diskへbind mountする。`/tmp` tmpfsだけで生成すると`SQLITE_FULL`になるため使用しない。
- 実測の全国出力は約5.44 GiB、download cacheは約3.41 GiB、最大都道府県出力は約317 MiBだった。cacheと生成一時領域はvalidator/inventory前にstep終了時のtrapで削除する。標準runnerでは47回の順次生成により360分timeoutが残余リスクであり、初回runで各prefix所要時間を記録する。
- job timeoutは360分。生成時間、upload時間、全量再download時間は初回runで別々に記録し、timeoutへ近づく場合はlarger/self-hosted runnerを別途承認する。
- R2権限は対象bucketのList/Get/Put/Deleteに限定する。Deleteは`finalize-release.yml`だけが、current/previous以外の検証済みprefixへ使用する。
- Custom Domainを同じCloudflare accountのzoneへ接続する。`r2.dev`は本番経路にしない。
- Cache Ruleは`/manifest.json`をbypassし、`/versions/*`だけをcache対象にする。JSON/TXTは既定でcacheされない場合があるため、固定version pathのruleを明示する。manifestをCache Everythingへ含めない。
- Native clientだけならCORSは不要。browser clientも提供する場合は、許可origin/method/headerを別途R2 CORSへ設定する。

Custom Domain、DNS、Cache Rule、CORS、Secrets、全国uploadは外部状態を変更するため、対象domain、公開範囲、費用影響、rollbackを確認してから実行する。

GitHub Environment variables:

- `R2_BUCKET`: R2 bucket名
- `PUBLIC_BASE_URL`: activate時必須の公開R2 Custom Domain base URL（legacy Data Workerを使う場合はそのURL）

GitHub Secrets（値はworkflowへ直書きしない）:

- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_ENDPOINT`: S3互換R2 endpoint（`https://host`形式）。endpoint hostはaccount識別子を含むため、variableではなくSecretにする。Actionsは各stepの`env:`ブロックを平文で描画するので、Secretにすることでログ上は自動的にマスクされる。

`R2_BUCKET`、`R2_ENDPOINT`、`PUBLIC_BASE_URL`はjob単位の`env:`へ置かない。R2へ実際にアクセスするstepと入力検証step、smoke testのstepにだけstep単位で渡す。これにより、生成stepなどR2と無関係なstepのログへ本番識別子が描画されない。

R2のendpoint、bucket、公開URL、認証値はこのリポジトリへ書かない。R2 access keyはmanifest read/write、対象prefix upload、検証済みretired prefix deleteだけの最小権限にする。workflow inputのversion/refは正規表現で検証し、AWS/Git/curlにはquote済み文字列で渡す。upstream clone、生成、validatorのstepにはR2 Secretsを渡さない。

## ABR配信元の地域制限と実行環境

ABRの配信CDN `data.address-br.digital.go.jp` は日本国外からのアクセスを `403` で拒否する。
upstream自身がソース（`src/lib/hub.test.ts`、`src/test_helpers/fixture_cache.ts`）に
この事実を記載しており、upstreamは既にUser-Agentを `curl/8.7.1` にしている。
つまりUser-Agentやリトライの調整では回避できない。

実測（2026-09-07、`abr-reachability.yml` の run `34071693433` と同一URLへのローカル実行）:

- GitHub-hosted runner（egress `US`）… 検索API `dataset.address-br` は `200`、配信CDNは
  upstreamのUser-Agentでもブラウザ相当のUser-Agentでも `403`
- 日本国内ネットワーク … 同一URL・同一User-Agentで `206`、検索APIは `200`

検索APIだけ国外から到達できるため、失敗は検索stepではなく最初のCDNダウンロードで表面化する。
`upstream-monitor.yml` はupstreamのgit commitを比較するだけなので影響を受けない。

`build-address-data.yml` は生成前に配信CDNへの到達性を確認し、届かない場合は数十秒で停止する。
到達性だけを単独で確認したい場合は `abr-reachability.yml` を実行する。どちらも `runner` inputで
実行環境を指定できるため、self-hosted runnerを用意してもworkflowの書き換えは不要。

### self-hosted runnerの前提

- 日本国内から通信すること。これが唯一の必須条件。
- Dockerが必要。生成stepは `node:22-bookworm` コンテナで実行する。macOSのrunnerには
  Dockerが標準で入らないため、Docker Desktopまたはcolimaを別途用意する。
- 一時領域に十分な空きが必要。実測で住居表示の結合SQLiteが約19.4GiB、生成物が約5.2GiB、
  upstreamキャッシュが約3.4GiBに達する。100GB以上を見込む。
- 公開リポジトリでのself-hosted runnerはGitHubが注意を促している構成である。生成workflowは
  `workflow_dispatch` 限定かつEnvironment承認必須だが、runnerは1ジョブで破棄するエフェメラル
  運用にし、外部コラボレーターのworkflow実行に承認を要求する設定を併用する。

## ローカル生成からの公開手順

GitHub-hosted runnerで生成できない間は、日本国内の作業機で生成し、検証済みの出力を直接R2へ
投入する。これは実際に全国版 `v2026-09-national-521f613` を公開した手順である。

1. upstreamをexact commitでcloneし、`run:01` から `run:99` までを順に実行する。各stageは
   使い捨てコンテナで動かし、`TMPDIR` はtmpfsではなくディスク上に置く。
2. `npm run dataset:validate -- <out>/api` が `valid:true` で終了することを確認する。
3. `npm run inventory -- generate <out> inventory.json _integrity/sha256.json` を実行する。
   同じ出力から2回生成してSHA-256が一致することを確認し、決定性を担保する。
4. 対象bucketのObject Read & Writeだけに限定したR2 API tokenを作成する。アカウント全体に
   届く既存の認証情報は使わない。設定は専用ファイルへ分離し、対象外bucketと`ListBuckets`が
   `403` になることを実際に確認してから書き込みを始める。
5. `_build.json`（`no-store`）、`api/`（`public,max-age=31536000,immutable`）、
   `_integrity/sha256.json`（immutable）の順に投入する。`sourceUpdatedAt` は
   `api/ja.json` の `meta.updated` から導出し、workflowと同じ契約に揃える。
6. version prefix全体を別ディレクトリへ再downloadし、`npm run inventory -- verify` を通す。
7. manifestを取得して直前の内容と一致することを確認してから `manifest register` を行い、
   `manifest validate` の後に `no-cache` で書き戻す。activateはここでは行わない。
8. `npm run smoke` と固定URL/Range/キャッシュヘッダを確認し、必要なら `manifest switch` で
   activateする。rollbackと再activateもmanifestの書き換えだけで完了する。
9. 公開後に `npm run accuracy -- <公開base URL> <version>` を実行し、精度証跡を残す。

rcloneを使う場合、bucket限定tokenでは `HeadBucket` が拒否されるため `--s3-no-check-bucket`
が必要になる。これを付けないとrcloneが `CreateBucket` を試みて `403` で失敗する。

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

精度suiteは `npm run accuracy -- <公開base URL> <version> [出力ファイル]` で実行する。公開経路そのものを読むため、配信経路の検証も兼ねる。都道府県ごとに1件を決定的に抽出し（seed固定のFNV-1aで選ぶため再実行しても同一住所）、政令市の区・離島市・島嶼町の固定ケースを加える。各町字の代表点と国土地理院の住所検索結果をhaversine距離で比較し、件数・解決数・min/median/p90/max・500m以内・1km以内・5km超を要約する。

距離の外れ値は必ずしも欠陥ではない。代表点の取り方の差で同一大字内に数百mの差が出ることがあり、国土地理院が島嶼部を`八丈島八丈町`のように郡相当を含む表記で索引しているため、ABR表記のままでは解決しない住所がある。要約だけで判断せず、個別ケースの座標を確認して原因を記録する。

consumer rolloutへの引継ぎは[`consumer-rollout.md`](consumer-rollout.md)を参照する。
