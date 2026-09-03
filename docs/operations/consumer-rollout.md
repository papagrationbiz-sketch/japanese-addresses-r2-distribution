# Consumer rollout handoff

全国versionを利用側へ渡すための汎用runbook。アプリ固有のコード、URL、資格情報はこのrepositoryへ保存しない。

## 注入契約

- build／deployment環境から完全なmanifest URL `https://<public-host>/manifest.json` を注入する。
- URLはhost rootの`manifest.json`に限定し、path prefix、query、fragment、userinfoを使わない。
- clientはmanifestの`current`を選んだ後、検索単位を`/versions/{version}/api/ja`へ固定する。manifestの`prefix`をURLとして信用しない。
- Swift client 0.1.3はこの固定URLとschema v1の未知optional fieldに対応する。`integrity`追加後もdecode互換を保つ。

## 段階導入

1. M6受入証跡を確認し、currentとpreviousの両prefixが公開GET/Range可能であることを確認する。
2. 開発／内部配布だけへmanifest URLを注入する。通常検索が端末cache優先で、住所文字列を配信側へ送らないことを確認する。
3. 同一地域の初回取得、再検索cache hit、offline、manifest更新、通信失敗を確認する。
4. current切替後、新旧cache keyが衝突しないことを確認する。
5. 配信manifestをpreviousへrollbackし、利用側が固定previous URLと既存cacheを再利用できることを実証する。
6. currentへ再切替し、段階対象を拡大する。previousは導入完了まで削除しない。

## 停止条件

次のいずれかで拡大を停止し、必要ならmanifestをpreviousへrollbackする。

- manifest、inventory、固定URLの不整合
- GET/Range status、Content-Range、Content-Length、ETagの契約違反
- current切替後のcache衝突、破損、offline回帰
- 配信障害時に既存検索結果を破壊する回帰
- 住所文字列、実URL、資格情報が永続logや公開差分へ混入
- 精度suiteまたは利用側の受入基準を満たさない

## rollback

1. cleanupを停止する。
2. manifestのcurrentとpreviousを交換する。
3. `npm run smoke -- <PUBLIC_BASE_URL> <expected-previous>`を実行する。
4. 利用側でprevious固定URL、端末cache、fallbackを確認する。
5. 原因と証跡を残す。修正版の再切替が完了するまでpreviousを保持する。

previousの削除は段階導入とrollback実証が完了した後の別判断であり、通常のolder-than-previous cleanupには含めない。

## 利用側の受入証跡

- 注入した環境名とmanifest host（資格情報や非公開URLは記録しない）
- 選択version、current/previous、固定URL path
- 初回missと2回目cache hit、offline結果
- version切替、rollback、再切替の結果
- 精度suite、fallback、回帰test、build結果
- 永続log／公開差分の秘密情報・住所文字列scan結果
