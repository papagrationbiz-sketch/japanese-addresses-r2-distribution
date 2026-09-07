# Data license and attribution

このリポジトリのソースコードは [`LICENSE`](LICENSE) のMIT Licenseで提供する。住所データ本体、生成物、実データfixtureはGitへ収録しない。

配信データは、原則として [`geolonia/japanese-addresses-v2`](https://github.com/geolonia/japanese-addresses-v2) の生成処理を使い、デジタル庁の [アドレス・ベース・レジストリ](https://www.digital.go.jp/policies/base_registry_address) を元に生成する。

- `japanese-addresses-v2` の生成コード: MIT License
- 生成された住所データ: [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/)
- 元データ: アドレス・ベース・レジストリ（デジタル庁）

## データ特性と既知の欠測

`*-地番.txt` の各行は `prc_num1,prc_num2,prc_num3,lng,lat` で、**`lng`/`lat` は空になり得る**。
これはABRの地番位置参照データ（`mt_parcel_pos_*`）の収録範囲がABRの地番マスター（`mt_parcel_*`）より
狭いためで、生成処理の不具合ではない。

実測（配信version `v2026-09-national-521f613`、地番shardを40件抽出、581万行）:

- 座標が空の行は **63.4%**
- 抽出した40ファイルのうち、全行に座標があるファイルは0件、全行が空のファイルが1件、残り39件は混在
- upstreamのダウンロードキャッシュ上、地番マスターは1,887市区町村分に対し位置参照は1,848市区町村分。
  39市区町村は位置参照データ自体が存在しない
- 例: 大分県別府市大字東山（`machiaza_id` `0021000`）は、ABRの `mt_parcel_pos_city442011.csv` に
  該当行が1件も無い。同市の位置参照ファイル自体は存在する（113,149行）ため、市区町村単位ではなく
  町字単位の欠測である

利用側は、地番レベルの座標が得られない場合を正常系として扱うこと。町字の代表点（市区町村JSONの
`point`）は別系統の値であり、地番の座標が空でも利用できる。町字代表点までしか解決できなかった結果を
地番レベルの結果と同じ精度として扱わないこと。

再配布・派生利用では、使用したupstream refとデータversion、upstream、元データ、CC BY 4.0を確認可能な形で表示する。元データとupstreamの最新の利用条件・注意事項を優先する。
