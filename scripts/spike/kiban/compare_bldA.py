"""2 時点の基盤地図情報 BldA（建築物）を比べる。読み取り専用。
使い方: python3 -I -X utf8 compare_bldA.py <旧の解凍フォルダ> <新の解凍フォルダ>
"""
import collections
import glob
import re
import sys

PAT = re.compile(
    r'<BldA gml:id="([^"]+)">\s*<fid>([^<]+)</fid>\s*'
    r'<lfSpanFr[^>]*>\s*<gml:timePosition>([^<]+)</gml:timePosition>\s*</lfSpanFr>\s*'
    r'<devDate[^>]*>\s*<gml:timePosition>([^<]+)</gml:timePosition>\s*</devDate>\s*'
    r'<orgGILvl>(\d+)</orgGILvl>\s*<area>.*?<gml:posList>\s*([^<]+?)\s*</gml:posList>.*?</area>\s*'
    r'<type>([^<]*)</type>',
    re.S,
)


def load(folder):
    feats = {}
    n_tags = 0
    for f in sorted(glob.glob(folder + "/*BldA*.xml")):
        x = open(f, encoding="utf-8").read()
        n_tags += x.count("<BldA ")
        for m in PAT.finditer(x):
            gid, fid, lf, dev, lvl, pos, typ = m.groups()
            coords = tuple(pos.split())
            feats[gid] = dict(fid=fid, lf=lf, dev=dev, lvl=lvl, coords=coords, type=typ)
    return feats, n_tags


def centroid(coords):
    pts = [(float(coords[i]), float(coords[i + 1])) for i in range(0, len(coords) - 2, 2)]
    return sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)


old, old_tags = load(sys.argv[1])
new, new_tags = load(sys.argv[2])
print("旧: タグ", old_tags, "解析", len(old), "／新: タグ", new_tags, "解析", len(new))
print("新の lfSpanFr 年別:", sorted(collections.Counter(v["lf"][:4] for v in new.values()).items()))
print("新の devDate 年別:", sorted(collections.Counter(v["dev"][:4] for v in new.values()).items()))
print("新の orgGILvl:", collections.Counter(v["lvl"] for v in new.values()))
print("新の type:", collections.Counter(v["type"] for v in new.values()).most_common())

# 1. 地物 ID（gml:id と fid）が版をまたいで保たれるか
old_gid, new_gid = set(old), set(new)
print("gml:id 共通:", len(old_gid & new_gid))
old_fid = {v["fid"] for v in old.values()}
new_fid = {v["fid"] for v in new.values()}
print("fid 共通:", len(old_fid & new_fid), "／旧", len(old_fid), "新", len(new_fid))

# 2. 形状の完全一致（座標の文字列が同じ）
old_shape = collections.Counter(v["coords"] for v in old.values())
new_shape = collections.Counter(v["coords"] for v in new.values())
same = sum(min(c, new_shape[k]) for k, c in old_shape.items() if k in new_shape)
print("座標が完全一致する建物:", same, "（旧の %.1f%%、新の %.1f%%）" % (100 * same / len(old), 100 * same / len(new)))

# 3. 完全一致しない新の建物の、lfSpanFr の年別（新築・更新の候補）
unmatched_new = [v for v in new.values() if v["coords"] not in old_shape]
print("新のうち座標が旧に無い建物:", len(unmatched_new))
print("  その lfSpanFr 年別:", sorted(collections.Counter(v["lf"][:4] for v in unmatched_new).items()))
matched_new = [v for v in new.values() if v["coords"] in old_shape]
print("新のうち座標が旧にもある建物の lfSpanFr 年別:", sorted(collections.Counter(v["lf"][:4] for v in matched_new).items()))
unmatched_old = [v for v in old.values() if v["coords"] not in new_shape]
print("旧のうち座標が新に無い建物:", len(unmatched_old))

# 4. 座標が少しずれただけの建物か（重心が近い）を、粗い格子で見る（約 1 m）
cell = 0.00001
grid = collections.defaultdict(list)
for v in unmatched_old:
    cx, cy = centroid(v["coords"])
    grid[(round(cx / cell), round(cy / cell))].append(v)
near = 0
for v in unmatched_new:
    cx, cy = centroid(v["coords"])
    gx, gy = round(cx / cell), round(cy / cell)
    if any((gx + dx, gy + dy) in grid for dx in (-1, 0, 1) for dy in (-1, 0, 1)):
        near += 1
print("座標が違うが、重心が約 1 m 以内に旧の建物がある新の建物:", near)
