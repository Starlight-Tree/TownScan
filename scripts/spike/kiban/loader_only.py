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


