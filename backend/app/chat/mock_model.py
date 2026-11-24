"""模擬モデル（既定の LLM）。日本語の規則で意図を決め、ツールを選び、結果から返答文をテンプレートで作る。

- 数字は、この文章のテンプレートに直接は書かない。ツールの結果の値だけを入れる（さらに guard_numbers が検査する）。
- 地区名は DB の areas.name・ward との部分一致。文脈は、クライアントが送る messages だけから作る（保存しない）。
- 実 LLM を足すときも、同じ plan（ツール呼び出しの列）→ 結果 → 文章 → guard_numbers の形にする。
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from typing import Any, Callable

from ..queries import CLASS_LABELS
from .guard import find_unsupported_numbers

ToolCall = dict[str, Any]


def normalize(text: str) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", text)).strip().lower()


def _rx(pattern: str) -> re.Pattern[str]:
    return re.compile(pattern, re.IGNORECASE)


# ---- 規則（正規表現。normalize 済みの文に使う） ----
INJECTION = _rx(r"指示を無視|命令を無視|ルールを無視|システムプロンプト|プロンプトを(?:見せ|教え|表示)|ignore (?:all|previous|the above)|system prompt|jailbreak|パスワード|api ?キー|api ?key|秘密鍵|トークン")
CHITCHAT = _rx(
    r"天気|気温|気象|降水|雨|雪|台風|ニュース|株価|為替|レシピ|料理|映画|音楽|ゲーム|スポーツ|野球|サッカー|占い|恋愛|翻訳"
    r"|プログラム|コードを書|冗談|歌って|詩を|小説|あなたは誰|だれが作|誰が作|何歳|こんにちは|こんばんは|おはよう|ありがとう|疲れ"
    r"|おすすめの(?:店|レストラン)|ランチ|ラーメン|joke"
)
SATELLITE = _rx(r"衛星|\bgee\b|earth ?engine|ヒートマップ|変化の当たり|変化のあたり|広域|埋め込み|sentinel|landsat|リモートセンシング|ndvi")
PANEL = _rx(r"パネル|太陽光|ソーラー|発電")
# 写真が無い時期を指す相対語（写真は 2018・2023 年だけなので、いまに近い話は答えられない）
RELATIVE_TIME = _rx(
    r"今年|昨年|去年|来年|今月|先月|直近|今日|昨日|おととし|一昨年|今週|先週|先日"
    r"|最近|近年|近頃|現在|現状|今後|将来|未来|ここ数年|この数年|数年前"
)
YEAR = re.compile(r"(?<!\d)((?:19|20)\d{2})(?!\d)")
PHOTO_YEARS = {2018, 2023}
# 年の書き方の揺れ: 漢数字（二〇二四・二千二十四）と和暦（令和6年・令和六年・R6年）を西暦に直して判定する
KANJI_NUM = "〇零一二三四五六七八九十百千"
KANJI_YEAR = re.compile(rf"([{KANJI_NUM}]{{2,}})年")
ERA_BASE = {"令和": 2018, "平成": 1988, "昭和": 1925, "大正": 1911, "明治": 1867}  # 西暦 = 基準 + 和暦の年
ERA_YEAR = re.compile(rf"(令和|平成|昭和|大正|明治)\s*(元|[0-9]{{1,2}}|[{KANJI_NUM}]+)\s*年")
ERA_LETTER_BASE = {"r": 2018, "h": 1988, "s": 1925}
ERA_LETTER_YEAR = re.compile(r"(?<![a-z0-9])([rhs])\s*([0-9]{1,2})\s*年")
OTHER_PLACES = _rx(
    r"東京|大阪|京都|名古屋|福岡|札幌|横浜|神戸|広島|仙台|北九州|長崎|大分|鹿児島|宮崎|佐賀|沖縄|那覇|八代|天草|宇土|益城|合志|菊陽|玉名|荒尾|山鹿|人吉|阿蘇|宇城"
    r"|北海道|青森|岩手|宮城|秋田|山形|福島|茨城|栃木|群馬|埼玉|千葉|神奈川|新潟|富山|石川|福井|山梨|長野|岐阜|静岡|愛知|三重|滋賀|兵庫|奈良|和歌山|鳥取|島根|岡山|山口|徳島|香川|愛媛|高知"
    r"|海外|アメリカ|中国|韓国|全国|県全域|県全体|(?<!熊本)市全域|(?<!熊本)市全体|熊本県"  # 「熊本市全域」は対象そのもの
)
PLACE_TOKEN = re.compile(r"[一-龥]{2,5}(?:市|区|町|村)")
PLACE_OK_TOKENS = {"熊本市"}
# 「渋谷の新築」「六本木ヒルズ周辺の建物」のような、<場所>の<このアプリの語> の形。場所の語が対象の語彙でなければ、対象外の場所と見なす
PLACE_NOUN = re.compile(r"([一-龥ァ-ヶー]{2,8}?)(?:周辺|付近|近辺|あたり|辺り)?(?:の|での|にある|にあたる)(?:新築|建物|建築|新規|候補|件数|写真|地図|棟)")
OWN_VOCABULARY = _rx(r"新築|新規|候補|建物|建築|描き漏れ|既存|保留|確定|地区|全体|全部|旧写真|新写真|写真|画像|地図|精度|一覧|面積|分類|件数|合計|最大|最新|中心部|結果|分析")
OWN_EXACT_WORDS = {"熊本", "熊本市", "市内", "中心部", "市中心部", "熊本市中心部"}
# 対象そのもの・時間を指す語。<場所>の位置に来ても、対象外の場所ではない。
# 「渋谷全域」のように、これらを除いて場所の語が残るなら、対象外の場所（部分一致で通さないために、除いた残りで見る）
OWN_SCOPE_WORDS = sorted(
    [
        "熊本市内", "熊本市", "熊本", "市内", "中心部", "市街地", "全域", "全エリア", "全地域", "全範囲", "エリア", "地域", "範囲", "区域", "域内", "圏内",
        "対象", "解析", "以前", "昔", "過去", "かつて", "当時", "従来", "最新", "以降", "以後", "その後", "当初",
    ],
    key=len, reverse=True,
)

CLS_NEW = _rx(r"新築|新規|新しく|新しい|新たに|増えた|できた|建った|建てられ|確定|旧写真に(?:無|な)い|新設")
CLS_OMIT = _rx(r"描き漏れ|描き漏らし|漏れ|既存|もともと|元から|既に|すでに|旧写真に(?:既|も)|データの抜け")
CLS_UNC = _rx(r"保留|不明|判定できない|曖昧|あいまい|微妙|不確か|はっきりしない|uncertain")
ALL_AREAS = _rx(r"全地区|すべての地区|全ての地区|全部の地区|全体|どの地区も")
FOLLOWUP = _rx(r"その|それ|そこ|ここ|同じ|さっき|先ほど|上の|前の|では|じゃあ|次は|他の|ほかの|もう一度|続き|同地区")

HELP = _rx(r"使い方|使いかた|できること|何ができ|なにができ|ヘルプ|\bhelp\b|機能|このアプリ(?:は|って)|説明して|どう(?:使|やって)|はじめて|初めて|何を聞|なにを聞|質問例|聞き方")
ACCURACY = _rx(r"精度|正解率|再現率|適合率|\bf1\b|\biou\b|評価|信頼|どれくらい正しい|どのくらい正しい|どのくらい当た|どれくらい当た|誤検出|正確|当たってる|合ってる|あってる")
PHOTO = _rx(r"写真|画像|見比べ|見くらべ|ビフォー|アフター|before|after|様子|検出画像|切り出し|拡大")
MAP = _rx(r"地図|マップ|位置|場所|どこにある|どこにあり|どの辺|どのあたり|ズーム|フォーカス")
COMPARE_STRONG = _rx(
    r"地区別|地区ごと|地区毎|区ごと|ランキング|順位|多い順|少ない順|どの地区|どこが|多い地区|少ない地区|多いところ"
    r"|一番多|最も多|もっとも多|最多|最少"
)
COMPARE_WEAK = _rx(r"比較|比べ|くらべ|違い|どちら|どっち")
LIST_EXPLICIT = _rx(r"一覧|リスト|表で|表に|表形式")
LIST = _rx(
    r"一覧|リスト|表で|表に|表形式|上位|トップ|\btop\b|大きい順|大きな順|面積順|一番大きい|最大|最も大きい"
    r"|大きい(?:もの|候補|新築|建物)|候補(?:を|は|が)?(?:見せ|出し|教え|ください|どれ|どんな)"
)
COUNT = _rx(r"何件|件数|いくつ|何棟|何個|何軒|何戸|何か所|数は|総数|合計|全部で|どれくらい|どのくらい|どれだけ|どのぐらい|多い|少ない|増え|ありますか|あります")
COUNT_STRONG = _rx(r"何件|件数|何棟|いくつ|何軒|何戸|何個")
# このアプリが扱わない向き（建物が無くなった・減った）。2023 年に新しく現れた候補だけを扱う
DISAPPEAR = _rx(r"取り壊|取壊|解体|壊され|撤去|滅失|無くなっ|なくなっ|消え|消滅|減っ|減少|あっ(?:て|た).{0,15}(?:無い|ない|なく|消)")
DOMAIN = _rx(r"新築|新規|建物|建築|棟|候補|描き漏れ|保留|分類|熊本|地区")

# \b は、日本語の文字も単語の文字と見るので、「c-…-1の写真」のように ID が日本語に直接つながると境界にならない。
# 半角の英数字とハイフンだけを境界にする（それ以外は、日本語・記号・空白・文頭文末のどれでも ID の区切り）
CANDIDATE_ID = re.compile(r"(?<![0-9A-Za-z-])c-[0-9]+-[0-9]+-[0-9]+(?![0-9A-Za-z-])")
AREA_ID = re.compile(r"(?<![0-9A-Za-z-])z[0-9]+-[0-9]+-[0-9]+(?![0-9A-Za-z-])")
LIMIT_A = re.compile(r"(?:上位|トップ|top)\s*(\d{1,3})")
LIMIT_B = re.compile(r"(\d{1,3})\s*(?:件|棟|個|つ)")
NAME_SUFFIX = re.compile(r"(?:[0-9一二三四五六七八九十]+丁目|丁目|町)$")

# 範囲外の返答文（数字は固定の年だけ。結果の message にそのまま入るので、guard は通る）
MSG_CHITCHAT = "このアプリは、熊本市中心部の空中写真から見つけた新築の候補（2018 年と 2023 年の写真の比較）についてだけ答えます。天気・雑談・設定の話などには答えられません。"
MSG_SATELLITE = "衛星による「変化の当たり」は未実装です。いま答えられるのは、空中写真から棟ごとに見つけた候補の件数・一覧・写真の見比べ・精度です。"
MSG_PANEL = "屋根の太陽光パネルの検出は未実装です。いま答えられるのは、空中写真から棟ごとに見つけた新築の候補についてです。"
MSG_DISAPPEAR = (
    "取り壊し・減少（2018 年にあって 2023 年に無い建物）は調べていません。"
    "このアプリが答えるのは、2018 年の写真に無く 2023 年の写真に新しく現れた建物（新築の候補）だけです。"
)
MSG_YEAR = "写真があるのは 2018 年と 2023 年だけです。それ以外の年（2024 年以降を含む）の棟の確認はできません。"


_KANJI_DIGITS = {"〇": 0, "零": 0, "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}
_KANJI_UNITS = {"十": 10, "百": 100, "千": 1000}


def kanji_to_int(text: str) -> int | None:
    """漢数字を整数にする。位取り（二〇二四）も、位つき（二千二十四・十二）も読む。読めなければ None。"""
    if not text:
        return None
    if all(c in _KANJI_DIGITS for c in text):
        return int("".join(str(_KANJI_DIGITS[c]) for c in text))
    total, digit = 0, None
    for c in text:
        if c in _KANJI_DIGITS:
            if digit is not None:  # 数字が続く（位が無い）のは、位つきの書き方ではない
                return None
            digit = _KANJI_DIGITS[c]
        elif c in _KANJI_UNITS:
            total += (1 if digit is None else digit) * _KANJI_UNITS[c]
            digit = None
        else:
            return None
    return total + (digit or 0)


def _era_number(token: str) -> int | None:
    if token == "元":
        return 1
    return int(token) if token.isdigit() else kanji_to_int(token)


def mentioned_years(text: str) -> set[int]:
    """文に出る年を西暦で集める。西暦（2024）・漢数字（二〇二四）・和暦（令和6年・令和六年・R6年）。text は normalize 済み。"""
    years = {int(y) for y in YEAR.findall(text)}
    for m in KANJI_YEAR.finditer(text):
        n = kanji_to_int(m.group(1))
        if n is not None and 1000 <= n <= 2999:
            years.add(n)
    for m in ERA_YEAR.finditer(text):
        n = _era_number(m.group(2))
        if n is not None:
            years.add(ERA_BASE[m.group(1)] + n)
    for m in ERA_LETTER_YEAR.finditer(text):
        years.add(ERA_LETTER_BASE[m.group(1)] + int(m.group(2)))
    return years


def strip_years(text: str) -> str:
    """漢数字・和暦の年の言い回し（二〇二三年・令和五年・R5年）を取り除く。<場所>の位置の語と取り違えないため。"""
    return ERA_LETTER_YEAR.sub(" ", ERA_YEAR.sub(" ", KANJI_YEAR.sub(" ", text)))


def is_own_place_word(word: str) -> bool:
    """<場所>の位置に来た語が、このアプリの対象（解析した地区・熊本市内・全域など）を指すか。"""
    if word in OWN_EXACT_WORDS or OWN_VOCABULARY.search(word):
        return True
    rest = word
    for w in OWN_SCOPE_WORDS:
        rest = rest.replace(w, "")
    return rest == ""


@dataclass
class Slots:
    area_ids: list[str] = field(default_factory=list)
    wards: list[str] = field(default_factory=list)  # 文に出た順。1 つでも複数でも
    cls: str | None = None
    candidate_id: str | None = None
    limit: int | None = None
    all_areas: bool = False

    def has_area(self) -> bool:
        return bool(self.area_ids or self.wards)


class MockModel:
    """areas = queries.list_areas の結果（地区名・区名の一致に使う）"""

    def __init__(self, areas: list[dict]):
        self.areas = areas
        self.wards = sorted({a["ward"] for a in areas if a.get("ward")})

    # ---- スロット（地区・分類・候補 ID・件数） ----
    def slots(self, text: str) -> Slots:
        s = Slots()
        m = CANDIDATE_ID.search(text)
        s.candidate_id = m.group(0) if m else None
        explicit_ids = AREA_ID.findall(text)
        s.all_areas = bool(ALL_AREAS.search(text))

        rest = text
        found = [w for w in self.wards if w in rest]
        s.wards = sorted(found, key=text.index)  # 複数の区が出たら、すべて使う（書いた順）
        for w in found:
            rest = rest.replace(w, " ")
        matched: list[str] = []
        for a in self.areas:
            name = normalize(a["name"] or "")
            if not name:
                continue
            core = NAME_SUFFIX.sub("", name)
            if name in rest or (len(core) >= 2 and core in rest):
                matched.append(a["id"])
        known = {a["id"] for a in self.areas}
        matched += [i for i in explicit_ids if i in known and i not in matched]
        if matched:
            s.area_ids = matched
            s.wards = []  # 地区名が分かるなら、区名より地区名を優先する
        if s.all_areas:
            s.area_ids, s.wards = [], []

        found = [c for c, rx in (("confirmed_new", CLS_NEW), ("existing_omission", CLS_OMIT), ("uncertain", CLS_UNC)) if rx.search(text)]
        if len(found) == 1:
            s.cls = found[0]
        if m := (LIMIT_A.search(text) or LIMIT_B.search(text)):
            s.limit = min(max(int(m.group(1)), 1), 50)
        return s

    # ---- 範囲外・未実装 ----
    def _refusal(self, text: str, s: Slots) -> ToolCall | None:
        def refuse(reason: str, message: str, suggestions: list[str] | None = None) -> ToolCall:
            args: dict[str, Any] = {"reason": reason, "message": message}
            if suggestions is not None:
                args["suggestions"] = suggestions
            return {"name": "refuse", "args": args}

        if INJECTION.search(text) or CHITCHAT.search(text):
            return refuse("out_of_scope", MSG_CHITCHAT)
        if SATELLITE.search(text):
            return refuse("not_implemented", MSG_SATELLITE)
        if PANEL.search(text):
            return refuse("not_implemented", MSG_PANEL)
        if DISAPPEAR.search(text):
            return refuse("not_implemented", MSG_DISAPPEAR)
        bare = AREA_ID.sub(" ", CANDIDATE_ID.sub(" ", text))
        if (mentioned_years(bare) - PHOTO_YEARS) or RELATIVE_TIME.search(bare):
            return refuse("no_photo_period", MSG_YEAR)
        if not s.has_area() and not s.all_areas:
            place_text = strip_years(text)
            token = next((t for t in PLACE_TOKEN.findall(place_text) if not t.endswith("地区") and t not in PLACE_OK_TOKENS), None)
            hit = OTHER_PLACES.search(place_text)
            noun_place = next((m.group(1) for m in PLACE_NOUN.finditer(place_text) if not is_own_place_word(m.group(1))), None)
            if token or hit or noun_place:
                label = token or (hit.group(0) if hit else noun_place)
                names = [a["name"] for a in self.areas if a.get("name")][:12]
                listing = f"解析した地区は、{'、'.join(names)} です。" if names else ""
                msg = f"「{label}」は、解析した地区に含まれていません。対象は熊本市中心部の、解析した地区だけです。{listing}"
                if find_unsupported_numbers(msg, [{"message": msg}]):
                    # 利用者の語に漢数字+助数詞（三年町など）が入ると、数字の検査で本文だけが差し替わる。語を写さない形にする
                    msg = f"その場所は、解析した地区に含まれていません。対象は熊本市中心部の、解析した地区だけです。{listing}"
                sug = [f"{names[0]}の新規出現候補は何件ですか？"] if names else None
                return refuse("out_of_scope", msg, sug)
        return None

    # ---- 文脈（直前までのメッセージから） ----
    def _inherit(self, s: Slots, history: list[dict], follow: bool) -> None:
        if not follow:
            return
        for m in reversed(history):
            text = normalize(m["content"])
            if m["role"] == "user":
                prev = self.slots(text)
                if not s.has_area() and not s.all_areas and prev.has_area():
                    s.area_ids, s.wards = prev.area_ids, prev.wards
                if s.cls is None and prev.cls:
                    s.cls = prev.cls
            if s.candidate_id is None and (c := CANDIDATE_ID.search(text)):
                s.candidate_id = c.group(0)
            if (s.has_area() or s.all_areas) and s.cls and s.candidate_id:
                break

    @staticmethod
    def _area_args(s: Slots) -> dict[str, Any]:
        args: dict[str, Any] = {}
        if s.area_ids:
            args["area_ids"] = s.area_ids
        elif len(s.wards) == 1:
            args["ward"] = s.wards[0]
        elif s.wards:
            args["wards"] = list(s.wards)
        return args

    # ---- 意図 → ツール呼び出し ----
    def plan(self, messages: list[dict]) -> list[ToolCall]:
        text = normalize(messages[-1]["content"])
        s = self.slots(text)
        if (refusal := self._refusal(text, s)) is not None:
            return [refusal]

        own_candidate = s.candidate_id
        own_filter = s.has_area() or s.all_areas or s.cls is not None  # 今回の文に、地区・分類の指定がある
        follow = bool(FOLLOWUP.search(text))
        self._inherit(s, messages[:-1], follow)
        area = self._area_args(s)
        cls = {"cls": s.cls} if s.cls else {}

        compare = bool(COMPARE_STRONG.search(text)) or bool(
            COMPARE_WEAK.search(text) and (len(s.area_ids) >= 2 or len(s.wards) >= 2 or not COUNT_STRONG.search(text))
        )

        def target() -> dict[str, Any]:
            # 候補 ID があればそれ（今回の文のもの、または文脈の直前の候補）。無ければ地区・分類の条件で最大の候補
            if s.candidate_id and (own_candidate or not own_filter):
                return {"candidate_id": s.candidate_id}
            return {**area, **cls}

        if own_candidate and not MAP.search(text):
            return [{"name": "show_candidate", "args": {"candidate_id": own_candidate}}]
        if HELP.search(text) and not ACCURACY.search(text):
            return [{"name": "show_help", "args": {}}]
        if ACCURACY.search(text):
            return [{"name": "get_accuracy", "args": {}}]
        if MAP.search(text) and not compare:
            return [{"name": "focus_map", "args": target()}]
        if PHOTO.search(text) and not LIST_EXPLICIT.search(text) and not compare and not COUNT_STRONG.search(text):
            return [{"name": "show_candidate", "args": target()}]
        if compare:
            return [{"name": "compare_areas", "args": {**area, **cls}}]
        if LIST.search(text):
            calls = [{"name": "list_candidates", "args": {**area, **cls, **({"limit": s.limit} if s.limit else {})}}]
            if COUNT.search(text):
                calls.insert(0, {"name": "count_candidates", "args": {**area, **cls}})
            return calls
        if s.has_area() or s.cls or DOMAIN.search(text) or COUNT_STRONG.search(text) or (COUNT.search(text) and follow):
            return [{"name": "count_candidates", "args": {**area, **cls}}]
        return [{"name": "refuse", "args": {"reason": "out_of_scope", "message": MSG_CHITCHAT}}]

    # ---- 結果 → 返答文 ----
    def compose(self, results: list[dict]) -> str:
        return "".join(render(r) for r in results)


# ---- 結果の文章化（型ごと。新しい結果の型を足すときは register_renderer） ----

def _int(v: int) -> str:
    return f"{v:,}"


def _ratio(v: float) -> str:
    return f"{v:.2f}"


def render_count(r: dict) -> str:
    scope = r["filter"].get("scope", "全地区")
    if r["total"] == 0:
        return f"{scope}には、該当する候補はありません。"
    if r["filter"].get("cls"):
        body = f"{scope}の「{r['breakdown'][0]['label']}」は {_int(r['total'])} 件です。"
    else:
        parts = "、".join(f"{b['label']} {_int(b['value'])} 件" for b in r["breakdown"])
        body = f"{scope}の新規出現候補は {_int(r['total'])} 件です。内訳は、{parts} です。"
    return body + "機械が写真から見つけた候補で、確定ではありません。"


def render_table(r: dict) -> str:
    if "filter" not in r:  # 使い方の表（候補の表には filter がある）
        return "このアプリは、熊本市中心部の空中写真から、新築の候補を棟ごとに見つけて答えます。次のように聞けます。"
    scope = r.get("filter", {}).get("scope", "全地区")
    if r["total"] == 0:
        return f"{scope}には、該当する候補はありません。"
    return (
        f"{scope}の候補を、面積の大きい順に {_int(r['shown'])} 件表示します（該当は全部で {_int(r['total'])} 件）。"
        "候補の ID を使って、その写真を見せて、と聞けます。"
    )


def render_compare(r: dict) -> str:
    scope = r.get("filter", {}).get("scope", "全地区")
    if not r["items"]:
        return f"{scope}には、比べる地区がありません。"
    top = r["items"][0]
    key = r.get("sort_key", "total")
    what = "候補の合計" if key == "total" else f"「{CLASS_LABELS.get(key, key)}」"
    return f"{scope}の地区ごとの件数を比べました。{what}が最も多いのは {top['name']} で、{_int(top['counts'][key])} 件です。"


def render_detection_image(r: dict) -> str:
    return f"候補 {r['candidate_id']} の写真を、{r['images'][0]['year']} 年と {r['images'][1]['year']} 年で並べます。{r['caption']}"


def render_map_focus(r: dict) -> str:
    return f"地図を合わせます: {r['title']}。"


def render_accuracy(r: dict) -> str:
    by_key = {m["key"]: m for m in r["metrics"]}

    def val(key: str) -> float | None:
        m = by_key.get(key)
        return None if m is None else m["value"]

    f1, pr, rc, tune = val("holdout_object_f1"), val("holdout_object_precision"), val("holdout_object_recall"), val("tune_object_f1")
    if f1 is None:
        head = "建物抽出の精度の値が、評価ファイルにありません。"
    else:
        years = r["provenance"].get("photo_years") or []
        when = f"{years[0]} 年の写真で" if years else ""
        head = f"建物抽出の精度を、基盤地図情報を参照にして、{when}実測しました。評価用の地区での物体単位 F1 は {_ratio(f1)} です。"
        if pr is not None and rc is not None:
            head += f"建物の抽出の適合率は {_ratio(pr)}、建物の抽出の再現率（基盤地図情報に対する値）は {_ratio(rc)} です。"
    if tune is not None:
        head += f"調整用の地区の F1 は {_ratio(tune)}（倍率と閾値を選ぶのに使ったので、参考値）です。"
    tail = "「新築の再現率」（本当の新築のうち候補に出せた割合）は、手ラベルが無いため未測定で、上の建物の抽出の再現率とは別の値です。分類の閾値は未検証の初期値です。"
    if r["provenance"].get("run_kind") == "synthetic":
        tail += "なお、これは合成データ（テスト用）の値です。"
    return head + tail


def render_refusal(r: dict) -> str:
    return r["message"]


def render_generic(r: dict) -> str:
    title = r.get("title")
    return f"{title} を表示します。" if title else "結果を表示します。"


RENDERERS: dict[str, Callable[[dict], str]] = {
    "count": render_count,
    "table": render_table,
    "compare": render_compare,
    "detection_image": render_detection_image,
    "map_focus": render_map_focus,
    "accuracy": render_accuracy,
    "refusal": render_refusal,
}


def register_renderer(result_type: str, fn: Callable[[dict], str]) -> None:
    """新しい結果の型（例: GEE の「変化の当たり」）の文章化を足す。"""
    RENDERERS[result_type] = fn


def render(result: dict) -> str:
    return RENDERERS.get(result.get("type", ""), render_generic)(result)
