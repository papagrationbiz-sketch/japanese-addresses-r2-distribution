# PROJECT: japanese-addresses-r2-distribution（GenNavi プロジェクトの構成要素）

公開 OSS として用意した住所データ配信基盤。実利用は GenNavi 向け。
目的地・現在地・判断ログの正本は GenNavi リポジトリの PROJECT.md。

- 役割: 上流の公開住所データセット japanese-addresses-v2 の更新を取り込み、生成・検証して、
  バージョン付き・地域分割で Cloudflare R2 から静的配信する（責任は manifest と配信に限定。
  正規化・ジオコーディングは含めない）。出典と再配布条件は DATA.md
- データの流れ: upstream (japanese-addresses-v2) → 生成・検証（GitHub Actions）→ R2 → 端末は
  manifest.json で current version を解決し、必要な地域の shard だけを取得
- ペア: 端末側クライアントは japanese-addresses-client-swift
- Observatory プロジェクト名: GenNavi
- 正本: https://github.com/papagrationbiz-sketch/GenNavi の PROJECT.md
