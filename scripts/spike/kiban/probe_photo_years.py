"""地理院の年度別写真（nendophoto{年}）が、各地点で何年分タイルとして取れるかを調べる。読み取りだけ。
地点ごと・年ごとに z15 のタイルを 1 枚ずつ取得し（間隔を空ける）、存在（HTTP 200）とサイズを表にする。
使い方: python3 probe_photo_years.py [年の開始=2020] [年の終了=2025]
出典: 国土地理院（地理院タイル）。写真そのものは保存しない。
"""
import math
import sys
import time
import urllib.error
import urllib.request

BASE = "https://cyberjapandata.gsi.go.jp/xyz/"
UA = "research-spike/0.1"
Z = 15

# 代表的な地点（緯度, 経度）。新築が多そうな郊外（鉄道沿線の開発地など）と、大都市・地方都市
POINTS = [
    ("東京 対象メッシュ（既に検証した所）", 35.7083, 139.8125),
    ("東京 豊洲・晴海", 35.6565, 139.7900),
    ("川崎 武蔵小杉", 35.5757, 139.6590),
    ("流山おおたかの森", 35.8717, 139.9253),
    ("柏の葉", 35.9019, 139.9526),
    ("つくば", 36.0825, 140.1119),
    ("千葉 ニュータウン中央", 35.8003, 140.1190),
    ("さいたま 浦和美園", 35.8760, 139.7420),
    ("横浜 みなとみらい", 35.4560, 139.6320),
    ("名古屋", 35.1709, 136.8815),
    ("大阪 梅田", 34.7055, 135.4983),
    ("神戸", 34.6937, 135.1955),
    ("京都", 35.0116, 135.7681),
    ("広島", 34.3853, 132.4553),
    ("福岡 博多", 33.5902, 130.4207),
    ("福岡 糸島", 33.5576, 130.1960),
    ("熊本", 32.8032, 130.7079),
    ("仙台", 38.2682, 140.8694),
    ("札幌", 43.0687, 141.3508),
    ("新潟", 37.9162, 139.0364),
    ("宇都宮", 36.5551, 139.8828),
    ("岡山", 34.6551, 133.9195),
    ("高松", 34.3428, 134.0466),
    ("那覇", 26.2124, 127.6809),
]


def tile(lat, lon, z=Z):
    n = 2 ** z
    x = int((lon + 180) / 360 * n)
    y = int((1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * n)
    return x, y


def probe(layer, z, x, y):
    for ext in ("png", "jpg"):
        req = urllib.request.Request(f"{BASE}{layer}/{z}/{x}/{y}.{ext}", headers={"User-Agent": UA})
        time.sleep(0.25)
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return len(r.read())
        except urllib.error.HTTPError as e:
            if e.code != 404:
                return -e.code
    return 0


def main():
    y0 = int(sys.argv[1]) if len(sys.argv) > 1 else 2020
    y1 = int(sys.argv[2]) if len(sys.argv) > 2 else 2025
    years = list(range(y0, y1 + 1))
    print("地点".ljust(22) + "".join(str(y).rjust(8) for y in years) + "  （バイト数。0 = タイル無し）")
    for name, lat, lon in POINTS:
        x, y = tile(lat, lon)
        row = [probe(f"nendophoto{yr}", Z, x, y) for yr in years]
        print(name.ljust(20) + "".join(str(v).rjust(8) for v in row), flush=True)


if __name__ == "__main__":
    main()
