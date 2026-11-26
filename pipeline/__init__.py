"""TownScan の後処理（Colab の確率配列 → 建物ポリゴン・評価・差分と 3 分類）。仕様は docs/spec-prototype.md §4〜§6。

使い方（リポジトリの直下で。開発コンテナの venv: ~/.venvs/townscan）:
  python -m pipeline.run_postprocess [--data-root data/townscan] [--run fr2] (--fixed 倍率,閾値 | --reference 正解の建物.geojson)
      入力 <data-root>/<run>/colab（meta*.json・prob_*.npy）→ 出力 <data-root>/<run>/out。--fixed は精度を測らない
      地区名は <data-root>/<run>/geocode.json（{area_id: 逆ジオコーダの応答}）があれば使う。外部へは通信しない。
  python -m pipeline.geocode --run-dir data/townscan/fr2   逆ジオコーダの取得（外部通信あり。メインが実行する）
  python -m pipeline.make_synthetic_run [出力先=data/townscan/synthetic]   合成データ（kind=synthetic）で入力と out/ を作る
      実データのある場所（data/townscan そのもの、合成と確かめられない colab/ などがある場所）には書かずに止まる
  python -m pytest pipeline/tests                           単体テストと通しのテスト（合成データ。外部通信なし）
"""
