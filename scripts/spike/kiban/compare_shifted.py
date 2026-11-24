"""2 つの版の建物（BldA）を、全体の位置のずれを補正して突き合わせる。読み取り専用。
座標参照系の変更などで、全建物が系統的にずれている版の組（例: 熊本の 2016-04 と 2018-10）向け。
使い方: python3 -I -X utf8 compare_shifted.py <旧の解凍フォルダ> <新の解凍フォルダ> [候補の出力先 JSON]
"""
import collections
import importlib.util
import json
import math
import statistics
import sys

here = __file__.rsplit("/", 1)[0]
spec = importlib.util.spec_from_file_location("cmp", here + "/loader_only.py")
cmp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cmp)

old, _ = cmp.load(sys.argv[1])
new, _ = cmp.load(sys.argv[2])
LAT_M = 111000.0


def feat(v):
    c = v["coords"]
    p = [(float(c[i]), float(c[i + 1])) for i in range(0, len(c) - 1, 2)]  # (緯度, 経度)
    lat0 = sum(q[0] for q in p) / len(p)
    lon_m = 111320.0 * math.cos(math.radians(lat0))
    xy = [((q[1]) * lon_m, q[0] * LAT_M) for q in p]
    ox, oy = xy[0]
    q = [(x - ox, y - oy) for x, y in xy]
    a = abs(sum(q[i][0] * q[i + 1][1] - q[i + 1][0] * q[i][1] for i in range(len(q) - 1))) / 2
    cx = sum(x for x, _ in xy) / len(xy)
    cy = sum(y for _, y in xy) / len(xy)
    return cx, cy, a, p


F_old = {g: feat(v) for g, v in old.items()}
F_new = {g: feat(v) for g, v in new.items()}
CELL = 4.0
grid = collections.defaultdict(list)
for g, (cx, cy, a, _) in F_old.items():
    grid[(int(cx // CELL), int(cy // CELL))].append(g)


def near(cx, cy, r, dx=0.0, dy=0.0):
    out = []
    gx, gy = int((cx - dx) // CELL), int((cy - dy) // CELL)
    n = int(r // CELL) + 1
    for i in range(-n, n + 1):
        for j in range(-n, n + 1):
            for g in grid.get((gx + i, gy + j), ()):
                ox, oy, oa, _ = F_old[g]
                if math.hypot(cx - dx - ox, cy - dy - oy) <= r:
                    out.append(g)
    return out


# 1. 全体のずれの推定（面積がほぼ同じ最近傍の組の、重心の差の中央値）
dxs, dys = [], []
for g, (cx, cy, a, _) in F_new.items():
    best = None
    for og in near(cx, cy, 3.0):
        ox, oy, oa, _ = F_old[og]
        if 0.8 <= a / max(oa, 1e-9) <= 1.25:
            d = math.hypot(cx - ox, cy - oy)
            if best is None or d < best[0]:
                best = (d, cx - ox, cy - oy)
    if best:
        dxs.append(best[1]); dys.append(best[2])
sx, sy = statistics.median(dxs), statistics.median(dys)
print("ずれの推定の組:", len(dxs), "／中央値: 東へ %.2f m, 北へ %.2f m" % (sx, sy))
print("  ずれの散らばり（四分位範囲）: 東 %.2f m, 北 %.2f m" % (
    statistics.quantiles(dxs, n=4)[2] - statistics.quantiles(dxs, n=4)[0],
    statistics.quantiles(dys, n=4)[2] - statistics.quantiles(dys, n=4)[0]))

# 2. ずれを補正して突き合わせる（重心が 1.0 m 以内・面積比 0.6〜1.6）
matched_new, matched_old = set(), set()
for g, (cx, cy, a, _) in F_new.items():
    for og in near(cx, cy, 1.0, sx, sy):
        ox, oy, oa, _ = F_old[og]
        if 0.6 <= a / max(oa, 1e-9) <= 1.6:
            matched_new.add(g); matched_old.add(og)
            break
un_new = [g for g in F_new if g not in matched_new]
un_old = [g for g in F_old if g not in matched_old]
print("旧", len(F_old), "新", len(F_new), "／補正後に突き合わせできた新:", len(matched_new), "(%.1f%%)" % (100 * len(matched_new) / len(F_new)))
print("新のうち突き合わせできない:", len(un_new), "／旧のうち突き合わせできない:", len(un_old))

# 3. 突き合わせできない新のうち、5 m 以内に旧の建物が全く無いもの（更地への新設の候補）
empty = []
for g in un_new:
    cx, cy, a, p = F_new[g]
    if not near(cx, cy, 5.0, sx, sy):
        empty.append(g)
print("  うち 5 m 以内に旧の建物が無い（更地への新設の候補）:", len(empty))
bk = collections.Counter()
for g in empty:
    a = F_new[g][2]
    bk["<10" if a < 10 else "10-30" if a < 30 else "30-100" if a < 100 else "100-300" if a < 300 else ">=300"] += 1
print("  面積別(m2):", dict(bk))
print("  新の type 別:", collections.Counter(new[g]["type"] for g in empty).most_common())

if len(sys.argv) > 3:
    out = []
    for g in sorted(empty):
        cx, cy, a, p = F_new[g]
        la = [q[0] for q in p]; lo = [q[1] for q in p]
        out.append({"gid": g, "type": new[g]["type"], "area_m2": round(a, 1),
                    "lat": round((min(la) + max(la)) / 2, 7), "lon": round((min(lo) + max(lo)) / 2, 7),
                    "ring": [[x, y] for x, y in p]})
    json.dump(out, open(sys.argv[3], "w", encoding="utf-8"), ensure_ascii=False)
    print("候補を書き出し:", sys.argv[3], len(out))
