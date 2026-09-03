# Security policy

## 境界

この基盤はR2 Custom Domain（またはlegacy Data Worker）経由で公開住所データを配信する。認証、個人情報、住所検索履歴、秘密情報を扱う機能は含まない。

Workerは次の入力を検証する。

- HTTP methodはGETだけ
- manifestのschema、version ID、R2 prefix、coverage
- object pathのpercent-decoding後のpath traversal
- Rangeは単一の明示的 `bytes=start-end` のみ
- versionごとの`api/...`はdeterministic SHA-256 inventoryで全件検証し、manifestにhash/count/bytesを記録する

不正Rangeはlegacy Data Worker経由の場合にR2へ転送せず `400` を返す。Cache APIの障害は同WorkerのR2レスポンスを失敗させない。本番既定はR2 Custom Domainの静的配信で、Workerを置く場合はlegacy互換レイヤーとして扱う。Worker間呼び出しが必要な場合はService Bindingを推奨する。finalizeではcurrentとpreviousを保持し、previousより古いprefixだけを削除する。

公開workflowは入力のversion、upstream ref、bucket、endpoint、公開URLを検証する。外部コマンドへは固定されたコマンド引数として渡し、shellで解釈される未検証の値を組み立てない。

公開時はbranch名ではなくレビュー済みのupstream exact commit（40桁lowercase SHA）を`upstream_ref`へ指定し、fetch後HEADとの完全一致を検証する。生成はupstream directoryだけをbind mountした非root `node:22-bookworm`コンテナで行い、root checkout、root `node_modules`、credentialsをmountしない。build後はcurrent+previousを保持し、受入確認後にのみ、Environment承認と`DELETE_OLDER_THAN_PREVIOUS`確認を伴うfinalizeを実行する。R2 access keyはmanifestのread/writeと対象prefixのupload/deleteに必要な最小権限だけを持たせる。upstream clone、生成、validatorにはR2 Secretsを渡さず、AWS操作stepのstep-level環境だけで参照する。

## Secretsとデータ

R2 endpoint、bucket名、access key、API tokenなどの実値をソース、workflow、Issue、ログへ書かない。CIではbucket／endpointをGitHub Environment variables、credentialsをGitHub Secretsに設定する。住所データと生成物はGitへコミットしない。

## 報告

脆弱性は公開Issueへ詳細を書かず、リポジトリ管理者へ非公開で報告する。再現手順、影響範囲、修正版の提案があれば添付する。
