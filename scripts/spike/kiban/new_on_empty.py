"""旧に建物が無かった場所に現れた新の建物（更地への新設の候補）を数える。読み取り専用。
使い方: python3 -I -X utf8 new_on_empty.py <旧の解凍フォルダ> <新の解凍フォルダ> [候補の出力先 JSON]
"""
import collections
import sys

sys.path.insert(0, __file__.rsplit("/", 1)[0])
import importlib.util

spec = importlib.util.spec_from_file_location("cmp", __file__.rsplit("/", 1)[0] + "/loader_only.py")
cmp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cmp)

old, _ = cmp.load(sys.argv[1])
new, _ = cmp.load(sys.argv[2])

LAT_M, LON_M = 111000.0, 90300.0  # 緯度 35.7 度付近の 1 度あたりのメートル


def pts(coords):
    # 最後の点（始点と同じ）まで含める。含めないと面積の計算で多角形が閉じない
    return [(float(coords[i]), float(coords[i + 1])) for i in range(0, len(coords) - 1, 2)]


def bbox(p):
    xs = [q[1] for q in p]; ys = [q[0] for q in p]  # 座標は「緯度 経度」の順
    return min(xs), min(ys), max(xs), max(ys)  # (lon_min, lat_min, lon_max, lat_max)


def area_m2(p):
    la0, lo0 = p[0]  # 原点を引いてから、メートルに直す（桁落ちを避ける）
    q = [((lo - lo0) * LON_M, (la - la0) * LAT_M) for la, lo in p]
    if q[0] != q[-1]:
        q.append(q[0])
    a = 0.0
    for (x1, y1), (x2, y2) in zip(q, q[1:]):
        a += x1 * y2 - x2 * y1
    return abs(a) / 2


CELL = 0.0001
grid = collections.defaultdict(list)
old_boxes = {}
for gid, v in old.items():
    b = bbox(pts(v["coords"]))
    old_boxes[gid] = b
    for cx in range(int(b[0] / CELL), int(b[2] / CELL) + 1):
        for cy in range(int(b[1] / CELL), int(b[3] / CELL) + 1):
            grid[(cx, cy)].append(gid)

old_shapes = {v["coords"] for v in old.values()}
MARGIN = 0.00002  # 約 2 m
empty, areas = [], []
for gid, v in new.items():
    if v["coords"] in old_shapes:
        continue
    p = pts(v["coords"])
    b = bbox(p)
    hit = False
    for cx in range(int((b[0] - MARGIN) / CELL), int((b[2] + MARGIN) / CELL) + 1):
        for cy in range(int((b[1] - MARGIN) / CELL), int((b[3] + MARGIN) / CELL) + 1):
            for og in grid.get((cx, cy), ()):
                ob = old_boxes[og]
                if ob[0] <= b[2] + MARGIN and ob[2] >= b[0] - MARGIN and ob[1] <= b[3] + MARGIN and ob[3] >= b[1] - MARGIN:
                    hit = True
                    break
            if hit: break
        if hit: break
    if not hit:
        a = area_m2(p)
        empty.append((gid, v["type"], a, b))

print("新のうち、旧に重なる建物が全く無い（約 2 m の余裕つき）:", len(empty))
bk = collections.Counter()
for _, t, a, _ in empty:
    bk["<10 m2" if a < 10 else "10-30" if a < 30 else "30-100" if a < 100 else "100-300" if a < 300 else ">=300"] += 1
print("面積別:", dict(bk))
print("種別:", collections.Counter(t for _, t, _, _ in empty).most_common())
big = [e for e in empty if e[2] >= 30]
print("30 m2 以上:", len(big))
# 位置の目安（確認用の見本 5 件。緯度経度）
for gid, t, a, b in sorted(big, key=lambda e: -e[2])[:5]:
    print("見本", gid, t, round(a), "m2", "lat %.5f lon %.5f" % ((b[1] + b[3]) / 2, (b[0] + b[2]) / 2))

# 候補の書き出し（任意）。写真での検証（validate_samples.py）の入力になる。
if len(sys.argv) > 3:
    import json
    out = []
    for gid, t, a, b in sorted(empty):
        v = new[gid]
        p = pts(v["coords"])
        out.append({
            "gid": gid, "type": t, "area_m2": round(a, 1),
            "lat": round((b[1] + b[3]) / 2, 7), "lon": round((b[0] + b[2]) / 2, 7),
            "ring": [[la, lo] for la, lo in p],
        })
    with open(sys.argv[3], "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False)
    print("候補を書き出し:", sys.argv[3], len(out))
