"""契約の検査に使うデータを DIR に書く（API には入れない。入れるのは `python -m pipeline.load --run DIR/run`）。

  DIR/run/    pipeline の出力の形（合成データ。contract/synthetic.py の write_run）
  DIR/tiles/  写真タイル（synthetic.py の write_tiles）に、画像の 404 を確かめるための故障を 3 つ足したもの
  DIR/outside.png  TILES_DIR の外にある、正しい PNG（シンボリックリンクの行き先）

故障（support/expected.py の TILE_FAULTS と同じ）:
  A2 試験町の 2018 年 = ファイルが無い / A3 仮想町の 2018 年 = PNG ではないファイル / A3 仮想町の 2023 年 = TILES_DIR の外を指すリンク

使い方: python contract/prepare_data.py --synthetic contract/synthetic.py --out DIR
（Pillow が要る。scripts/test-contract.sh は、contract のイメージの中で流す。アプリの API のコードは使わない）
"""

from __future__ import annotations

import argparse
import importlib.util
import os
from pathlib import Path

from support import expected


def load_synthetic(path: Path):
    spec = importlib.util.spec_from_file_location("synthetic", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)  # synthetic.py は標準ライブラリと Pillow だけに依存する
    return module


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--synthetic", required=True, type=Path, help="合成データの生成スクリプト（contract/synthetic.py）")
    ap.add_argument("--out", required=True, type=Path, help="書き出す先（空のディレクトリ）")
    ns = ap.parse_args()

    synthetic = load_synthetic(ns.synthetic)
    out: Path = ns.out
    synthetic.write_run(out / "run")
    tiles = out / "tiles"
    synthetic.write_tiles(tiles)

    # 行き先（TILES_DIR の外にある、正しい PNG）。これを読んで 200 を返したら、外を読んだことになる
    from PIL import Image

    Image.new("RGB", (256, 256), (1, 2, 3)).save(out / "outside.png")

    for (area_id, year), fault in expected.TILE_FAULTS.items():
        area = expected.AREA_BY_ID[area_id]
        path = tiles / str(year) / f"{area.x}_{area.y}.png"
        path.unlink()
        if fault == "corrupt":
            path.write_bytes(b"not a png")
        elif fault == "symlink_outside":
            os.symlink("../../outside.png", path)  # tiles/{year}/ から見て ../../outside.png = DIR/outside.png
        elif fault != "missing":
            raise SystemExit(f"未知の故障: {fault}")
    print(f"書き出しました: {out}（run/・tiles/・outside.png）")


if __name__ == "__main__":
    main()
