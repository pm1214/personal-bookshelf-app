#!/usr/bin/env python3
"""
楽天Kobo電子書籍検索API 巻番号取得の検証スクリプト（v2）

測るもの
  1. 巻番号の「抽出率」：巻として扱う商品のうち、巻番号が取れた割合（正解データ不要）
  2. 巻番号の「正解率・適合率・再現率」：正解データCSV（--truth）と照合
  3. 商品の分類：本編・続編・外伝・コミカライズ・単話・分冊・特装版・合本版
  4. 検索の件数：APIの総件数・取得件数・ページ数・取得上限に達したか

巻番号の規則はアプリ本体（TypeScript の src/volume/volumeKey.ts / parseVolumeTitle.ts）と同じ。
fixtures/volume-label-cases.json と fixtures/volume-title-cases.json で一致を確かめる（tools/test_kobo_volume_check.py）。

APIキーの扱い（公式ドキュメント https://webservice.rakuten.co.jp/documentation/kobo-ebook-search）
  - accessKey は「ヘッダー または クエリパラメーター」で指定できる。
    URL はログに残りやすいので、既定ではヘッダー（accessKey）だけで送る。
    ヘッダーで通らない環境のときだけ --key-in-query を付ける。
  - キーは環境変数からだけ読む（コマンド引数では受け取らない。履歴に残るため）
  - エラー表示・保存するファイルに、キーの文字列は出さない（*** に置き換える）

使い方
  export RAKUTEN_APP_ID="..."
  export RAKUTEN_ACCESS_KEY="..."
  export RAKUTEN_REFERER="https://（楽天のアプリ設定に登録したWebサイトURL）"   # 必要な場合
  python3 kobo_volume_check.py -f titles.txt                      # 検索して評価
  python3 kobo_volume_check.py -f titles.txt --truth truth.csv    # 正解データと照合
  python3 kobo_volume_check.py -f titles.txt --save-raw           # APIの応答を保存（キーは含まない）
  python3 kobo_volume_check.py --from-raw out/raw --truth truth.csv  # 保存した応答で再評価（API不要）
  python3 kobo_volume_check.py --selftest                         # 解析規則の自己テスト（API不要）

出力（-o で指定したフォルダ。既定 out）
  report.md     人が読むレポート（集計・誤判定・あいまいな結果の一覧）
  summary.csv   検索語ごとの集計
  items.csv     取得した全商品と判定結果
  metrics.json  数値の結果（機械で比べる用）

正解データCSV（--truth）の列（見出し名で探す。BOM 付き UTF-8 可）
  itemNumber      商品番号（あれば優先して照合）
  title           商品タイトル（itemNumber が無いとき、完全一致で照合）
  expected_label  正しい巻（"10" "10.5" "上" など。巻が無い商品は空）
  expected_category  正しい分類（main/sequel/spinoff/comicalize/episode/split/special/bundle。空なら評価しない）

必要なもの: Python 3.9 以上。追加ライブラリ不要。
"""

from __future__ import annotations

import argparse
import csv
import datetime as _dt
import json
import os
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Callable, Iterable, Optional

ENDPOINT = "https://openapi.rakuten.co.jp/services/api/Kobo/EbookSearch/20170426"
WAIT_SEC = 1.0          # ページ間の待ち時間。短時間の大量アクセスは一時停止の対象
HITS_PER_PAGE = 30      # API の上限
API_MAX_PAGE = 100      # API の page パラメーターの上限

# src/limits.ts と同じ値（test_kobo_volume_check.py で fixtures と照合）
MAX_VOLUME_NUMBER = 999
MAX_VOLUME_DECIMALS = 3
MAX_LABEL_LENGTH = 20

CATEGORIES = ["main", "sequel", "spinoff", "comicalize", "episode", "split", "special", "bundle"]
CATEGORY_JA = {
    "main": "本編", "sequel": "続編", "spinoff": "外伝・番外編", "comicalize": "コミカライズ",
    "episode": "単話", "split": "分冊", "special": "特装版・限定版", "bundle": "合本・セット",
}

# ---------------------------------------------------------------------------
# 巻ラベル（src/volume/volumeKey.ts parseVolumeLabel と同じ規則）
# ---------------------------------------------------------------------------

KANJI_DIGITS = {"〇": 0, "零": 0, "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}
PART_ORDER = {"上": (1, "上"), "中": (2, "中"), "下": (3, "下"), "前": (1, "前編"), "後": (3, "後編")}
SINGLE_WORDS = {"単巻", "単行本", "全1巻", "全一巻", "single"}


def nfkc(s: Any) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", "" if s is None else str(s))).strip()


def kanji_to_int(s: str) -> Optional[int]:
    if not s:
        return None
    if s == "百":
        return 100
    if all(c in KANJI_DIGITS for c in s):
        return int("".join(str(KANJI_DIGITS[c]) for c in s))
    m = re.fullmatch(r"([一二三四五六七八九])?十([一二三四五六七八九])?", s)
    if m:
        return (KANJI_DIGITS[m.group(1)] if m.group(1) else 1) * 10 + (KANJI_DIGITS[m.group(2)] if m.group(2) else 0)
    return None


@dataclass
class Ident:
    key: str
    label: str
    kind: str      # number / part / named / single
    group: int
    value: float


def parse_volume_label(inp: Any) -> tuple[Optional[Ident], Optional[str]]:
    """(Ident, None) か (None, エラー文)。"""
    s = nfkc(inp)
    if not s:
        return None, "巻が空です"
    if re.search(r"[\x00-\x1f\x7f]", s):
        return None, "巻に使えない文字が含まれています"
    if s.lower() in SINGLE_WORDS:
        return Ident("single", "単巻", "single", 3, 0), None
    core = re.sub(r"^第\s*", "", s)
    core = re.sub(r"\s*巻$", "", core)
    core = re.sub(r"^vol(?:ume)?\.?\s*", "", core, flags=re.I).strip()
    if re.match(r"^[+-]?[0-9]+(?:\.[0-9]+)?\s*-\s*[0-9]", core):
        return None, "範囲（1-3 など）は1つの巻として使えません"
    if re.match(r"^-\s*[0-9]", core):
        return None, "巻番号に負の数は使えません"
    if re.fullmatch(r"[0-9]+(\.[0-9]+)?", core):
        int_part, _, dec = core.partition(".")
        dec = dec.rstrip("0")
        if len(dec) > MAX_VOLUME_DECIMALS:
            return None, f"小数の巻は小数点以下{MAX_VOLUME_DECIMALS}桁までです"
        iv = int(int_part)
        if iv > MAX_VOLUME_NUMBER:
            return None, f"巻番号は{MAX_VOLUME_NUMBER}までです"
        label = f"{iv}.{dec}" if dec else str(iv)
        return Ident(f"n:{label}", label, "number", 0, float(label)), None
    k = kanji_to_int(core)
    if k is not None:
        if k > MAX_VOLUME_NUMBER:
            return None, f"巻番号は{MAX_VOLUME_NUMBER}までです"
        return Ident(f"n:{k}", str(k), "number", 0, float(k)), None
    m = re.fullmatch(r"([上中下前後])(?:編)?", core)
    if m:
        v, label = PART_ORDER[m.group(1)]
        return Ident(f"p:{m.group(1)}", label, "part", 1, float(v)), None
    if len(core) > MAX_LABEL_LENGTH:
        return None, f"巻の表記は{MAX_LABEL_LENGTH}文字までです"
    if re.match(r"^[0-9]", core) and re.search(r"[0-9]{4,}", core):
        return None, f"巻番号は{MAX_VOLUME_NUMBER}までです"
    if re.search(r"[,、;；|]", core):
        return None, "巻の表記にカンマや | は使えません"
    return Ident(f"x:{core}", core, "named", 2, 0.0), None


# ---------------------------------------------------------------------------
# 商品タイトル（src/volume/parseVolumeTitle.ts と同じ規則）＋ 細かい分類
# ---------------------------------------------------------------------------

EPISODE_RE = re.compile(r"(単話|分冊|話売り|第\s*[0-9]+\s*話|[0-9]+\s*話|連載版|episode|#[0-9]+)", re.I)
SPECIAL_RE = re.compile(r"(特装|限定|特別|デラックス|DX版|完全版|新装|愛蔵|カラー版|フルカラー)")
BUNDLE_RE = re.compile(r"(合本|セット|まとめ買い|全[0-9]+巻|BOX|[0-9]+\s*-\s*[0-9]+\s*巻)", re.I)
NOISE_RE = re.compile(r"[【\[][^】\]]*[】\]]")
NON_VOLUME_PAREN_RE = re.compile(r"[(（](?![\s0-9.上中下前後]+[)）])[^)）]*[)）]")
EDITION_WORD_RE = re.compile(r"\S*(特装|限定|特別|通常|デラックス|完全|新装|愛蔵|カラー)版")

# 細かい分類（検証用。優先順：合本 > 単話 > 分冊 > 特装 > コミカライズ > 外伝 > 続編 > 本編）
CATEGORY_RULES = [
    ("bundle", BUNDLE_RE),
    ("episode", re.compile(r"(単話|話売り|第\s*[0-9]+\s*話|[0-9]+\s*話|連載版|episode|#[0-9]+)", re.I)),
    ("split", re.compile(r"分冊")),
    ("special", SPECIAL_RE),
    ("comicalize", re.compile(r"(コミカライズ|コミック版|漫画版|マンガ版|THE COMIC|ザ・コミック)", re.I)),
    ("spinoff", re.compile(r"(外伝|番外編|スピンオフ|アンソロジー|公式ガイド|ファンブック|短編集)")),
    ("sequel", re.compile(r"(第[0-9一二三四五六七八九十]+部|新章|続編|続・|2nd|セカンド|season\s*[0-9]+|シーズン\s*[0-9]+)", re.I)),
]


def _num(g: str) -> Optional[tuple[float, str]]:
    ident, _ = parse_volume_label(g)
    if ident and ident.kind == "number":
        return ident.value, ident.label
    return None


def _kanji_rule(g: str) -> Optional[tuple[float, str]]:
    n = kanji_to_int(g)
    return None if n is None else (float(n), str(n))


TITLE_RULES: list[tuple[str, re.Pattern, Callable[[str], Optional[tuple[float, str]]]]] = [
    ("巻", re.compile(r"第?\s*([0-9]+(?:\.[0-9]+)?)\s*巻"), _num),
    ("巻(漢数字)", re.compile(r"第?\s*([一二三四五六七八九十〇百]+)\s*巻"), _kanji_rule),
    ("括弧", re.compile(r"[(（]\s*([0-9]+(?:\.[0-9]+)?)\s*[)）]"), _num),
    ("Vol", re.compile(r"vol(?:ume)?\.?\s*([0-9]+(?:\.[0-9]+)?)", re.I), _num),
    ("上下", re.compile(r"(?:^|[\s(（])([上中下前後])(?:巻|編)?(?:$|[\s)）])"), lambda g: (float(PART_ORDER[g][0]), g)),
    ("末尾数字", re.compile(r"\s([0-9]+(?:\.[0-9]+)?)\s*$"), _num),
]


@dataclass
class ParsedTitle:
    label: str           # 取れなければ ""
    value: Optional[float]
    rule: str
    kind: str            # volume / episode / bundle（TypeScript と同じ）
    category: str        # 細かい分類
    special: bool
    base_title: str


def _clean_base(s: str) -> str:
    s = re.sub(r"[(（][^)）]*[)）]", " ", s)
    s = re.sub(r"[\s:：・\-－]+$", "", s)
    return nfkc(s)


def classify(raw: str) -> str:
    for name, rx in CATEGORY_RULES:
        if rx.search(raw):
            return name
    return "main"


def parse_title(title: str) -> ParsedTitle:
    raw = nfkc(title)
    special = bool(SPECIAL_RE.search(raw))
    kind = "bundle" if BUNDLE_RE.search(raw) else "episode" if EPISODE_RE.search(raw) else "volume"
    category = classify(raw)
    t = NOISE_RE.sub(" ", raw)
    t = NON_VOLUME_PAREN_RE.sub(" ", t)
    t = nfkc(EDITION_WORD_RE.sub(" ", t))
    if kind == "bundle":
        return ParsedTitle("", None, "セット", kind, category, special, _clean_base(re.sub(BUNDLE_RE.pattern, " ", t, flags=re.I)))
    for name, rx, read in TITLE_RULES:
        m = rx.search(t)
        if not m:
            continue
        r = read(m.group(1))
        if r is None:
            continue
        base = t[: m.start()] + " " + t[m.end():]
        return ParsedTitle(r[1], r[0], name, kind, category, special, _clean_base(base))
    return ParsedTitle("", None, "取れず", kind, category, special, _clean_base(t))


def label_key(label: Optional[str]) -> Optional[str]:
    if not label:
        return None
    ident, _ = parse_volume_label(label)
    return ident.key if ident else f"?:{nfkc(label)}"


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------

class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(f"{status} {code}: {message}")
        self.status, self.code, self.message = status, code, message


@dataclass
class Config:
    app_id: str
    access_key: str
    referer: Optional[str] = None
    key_in_query: bool = False
    wait_sec: float = WAIT_SEC


def mask(text: str, secrets: Iterable[str]) -> str:
    for s in secrets:
        if s and len(s) >= 4:
            text = text.replace(s, "***")
    return text


def build_url(params: dict, cfg: Config) -> str:
    q = {"applicationId": cfg.app_id, "format": "json", "formatVersion": 2, **params}
    if cfg.key_in_query:
        q["accessKey"] = cfg.access_key
    return ENDPOINT + "?" + urllib.parse.urlencode(q)


def call_api(params: dict, cfg: Config, opener: Callable = urllib.request.urlopen, sleep: Callable = time.sleep) -> dict:
    url = build_url(params, cfg)
    headers = {"User-Agent": "bookshelf-hub-kobo-check/2.0", "Accept": "application/json", "accessKey": cfg.access_key}
    if cfg.referer:
        headers["Referer"] = cfg.referer
        p = urllib.parse.urlparse(cfg.referer)
        headers["Origin"] = f"{p.scheme}://{p.netloc}"
    req = urllib.request.Request(url, headers=headers)
    secrets = [cfg.access_key, cfg.app_id]
    for attempt in range(3):
        try:
            with opener(req, timeout=20) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            body = mask(e.read().decode("utf-8", "replace"), secrets)
            try:
                j = json.loads(body)
            except ValueError:
                j = {}
            code = str(j.get("error", "")) or f"http_{e.code}"
            if e.code == 404 and code in ("not_found", "http_404"):
                return {"count": 0, "pageCount": 0, "Items": []}
            if e.code == 429 and attempt < 2:
                sleep(5 * (attempt + 1))
                continue
            raise ApiError(e.code, code, mask(str(j.get("error_description", body))[:300], secrets)) from None
        except urllib.error.URLError as e:
            raise ApiError(0, "network", mask(str(e.reason), secrets)) from None
    raise ApiError(429, "too_many_requests", "リトライ上限に達しました")


def hint_for(err: ApiError) -> str:
    t = f"{err.code} {err.message}".upper()
    if "REFER" in t:
        return "→ RAKUTEN_REFERER に、アプリ設定で登録したWebサイトURLを入れてください。"
    if "ACCESS" in t or "KEY" in t:
        return "→ RAKUTEN_ACCESS_KEY を確認してください。ヘッダーで通らない場合は --key-in-query を試してください。"
    if "APPLICATIONID" in t:
        return "→ RAKUTEN_APP_ID を確認してください。"
    return ""


@dataclass
class SearchRecord:
    query: str
    api_count: int = 0          # API が報告した総件数
    page_count: int = 0         # API が報告した総ページ数
    pages_fetched: int = 0
    fetched: int = 0            # 実際に受け取った件数（重複除去後）
    duplicates_dropped: int = 0
    truncated: bool = False     # --pages の上限で打ち切った
    api_limit_hit: bool = False  # API の page 上限（100）に達した＝これ以上は取れない
    items: list = field(default_factory=list)
    raw_pages: list = field(default_factory=list)


def item_of(x: Any) -> Optional[dict]:
    if isinstance(x, dict) and "Item" in x and isinstance(x["Item"], dict):
        x = x["Item"]
    if not isinstance(x, dict) or not isinstance(x.get("title"), str) or not x.get("title"):
        return None
    if x.get("itemNumber") is None:
        return None
    x = dict(x)
    x["itemNumber"] = str(x["itemNumber"])
    return x


def search(query: str, cfg: Config, max_pages: int, fetch: Callable[[dict], dict], sleep: Callable = time.sleep, log=print) -> SearchRecord:
    rec = SearchRecord(query)
    seen: set[str] = set()
    page = 1
    while True:
        data = fetch({"title": query, "hits": HITS_PER_PAGE, "page": page, "sort": "+releaseDate"})
        rec.raw_pages.append(data)
        rec.api_count = int(data.get("count") or 0)
        rec.page_count = int(data.get("pageCount") or 0)
        rec.pages_fetched = page
        got = [i for i in (item_of(x) for x in (data.get("Items") or data.get("items") or [])) if i]
        for it in got:
            if it["itemNumber"] in seen:
                rec.duplicates_dropped += 1
                continue
            seen.add(it["itemNumber"])
            rec.items.append(it)
        log(f"  {query}: {page}/{rec.page_count}ページ, 累計{len(rec.items)}件")
        if not got or page >= rec.page_count:
            break
        if page >= max_pages or page >= API_MAX_PAGE:
            break
        page += 1
        sleep(cfg.wait_sec)
    rec.fetched = len(rec.items)
    rec.truncated = rec.page_count > rec.pages_fetched
    rec.api_limit_hit = rec.page_count > API_MAX_PAGE or (rec.pages_fetched >= API_MAX_PAGE and rec.truncated)
    return rec


# ---------------------------------------------------------------------------
# 評価
# ---------------------------------------------------------------------------

@dataclass
class Truth:
    expected_label: Optional[str]
    expected_category: Optional[str]


def load_truth(path: Path) -> tuple[dict[str, Truth], dict[str, Truth], list[str]]:
    by_item: dict[str, Truth] = {}
    by_title: dict[str, Truth] = {}
    problems: list[str] = []
    with open(path, encoding="utf-8-sig", newline="") as f:
        rd = csv.DictReader(f)
        cols = {nfkc(c): c for c in (rd.fieldnames or [])}
        if "expected_label" not in cols:
            raise SystemExit(f"{path}: 見出しに expected_label が必要です")
        for i, row in enumerate(rd, start=2):
            get = lambda k: nfkc(row.get(cols[k], "")) if k in cols else ""
            label = get("expected_label") or None
            if label:
                ident, err = parse_volume_label(label)
                if not ident:
                    problems.append(f"{path.name} {i}行目: expected_label「{label}」が読めません（{err}）")
                    continue
            cat = get("expected_category") or None
            if cat and cat not in CATEGORIES:
                problems.append(f"{path.name} {i}行目: expected_category「{cat}」は {', '.join(CATEGORIES)} のどれかにしてください")
                cat = None
            t = Truth(label, cat)
            if get("itemNumber"):
                by_item[get("itemNumber")] = t
            elif get("title"):
                by_title[get("title")] = t
            else:
                problems.append(f"{path.name} {i}行目: itemNumber か title が必要です")
    return by_item, by_title, problems


def prf(tp: int, fp: int, fn: int) -> dict:
    p = tp / (tp + fp) if tp + fp else None
    r = tp / (tp + fn) if tp + fn else None
    f1 = 2 * p * r / (p + r) if p and r else None
    return {"tp": tp, "fp": fp, "fn": fn, "precision": p, "recall": r, "f1": f1}


def evaluate(records: list[SearchRecord], truth: Optional[tuple[dict, dict]] = None) -> dict:
    rows: list[dict] = []
    per_query: list[dict] = []
    for rec in records:
        parsed = [(it, parse_title(it["title"])) for it in rec.items]
        vol_items = [p for _, p in parsed if p.kind == "volume"]
        with_label = [p for p in vol_items if p.label]
        labels = Counter(label_key(p.label) for p in with_label if p.category == "main")
        dups = sorted(k for k, n in labels.items() if n > 1)
        cats = Counter(p.category for _, p in parsed)
        per_query.append({
            "query": rec.query, "api_count": rec.api_count, "page_count": rec.page_count,
            "pages_fetched": rec.pages_fetched, "fetched": rec.fetched, "truncated": rec.truncated,
            "api_limit_hit": rec.api_limit_hit, "duplicates_dropped": rec.duplicates_dropped,
            "volume_items": len(vol_items), "extracted": len(with_label),
            "extraction_rate": (len(with_label) / len(vol_items)) if vol_items else None,
            "categories": dict(cats), "duplicate_main_labels": [k[2:] if k else k for k in dups],
        })
        for it, p in parsed:
            rows.append({"query": rec.query, "item": it, "parsed": p})

    result: dict[str, Any] = {"per_query": per_query}
    all_vol = sum(q["volume_items"] for q in per_query)
    all_ext = sum(q["extracted"] for q in per_query)
    result["overall"] = {
        "items": len(rows), "volume_items": all_vol, "extracted": all_ext,
        "extraction_rate": (all_ext / all_vol) if all_vol else None,
        "categories": dict(Counter(r["parsed"].category for r in rows)),
    }

    if truth:
        by_item, by_title = truth
        tp = fp = fn = exact = n = 0
        cat_conf: dict[tuple[str, str], int] = Counter()
        mistakes: list[dict] = []
        for r in rows:
            it, p = r["item"], r["parsed"]
            t = by_item.get(it["itemNumber"]) or by_title.get(nfkc(it["title"]))
            if not t:
                continue
            n += 1
            r["truth"] = t
            pk, ek = label_key(p.label), label_key(t.expected_label)
            if pk == ek:
                exact += 1
            if pk and ek and pk == ek:
                tp += 1
            if pk and pk != ek:
                fp += 1
            if ek and pk != ek:
                fn += 1
            if pk != ek:
                mistakes.append({"query": r["query"], "title": it["title"], "itemNumber": it["itemNumber"],
                                 "predicted": p.label or "", "expected": t.expected_label or "", "rule": p.rule})
            if t.expected_category:
                cat_conf[(t.expected_category, p.category)] += 1
                if t.expected_category != p.category:
                    mistakes.append({"query": r["query"], "title": it["title"], "itemNumber": it["itemNumber"],
                                     "predicted": CATEGORY_JA[p.category], "expected": CATEGORY_JA[t.expected_category], "rule": "分類"})
        cats_eval = {}
        for c in CATEGORIES:
            ctp = cat_conf.get((c, c), 0)
            cfp = sum(v for (e, pr), v in cat_conf.items() if pr == c and e != c)
            cfn = sum(v for (e, pr), v in cat_conf.items() if e == c and pr != c)
            if ctp + cfp + cfn:
                cats_eval[c] = prf(ctp, cfp, cfn)
        total_cat = sum(cat_conf.values())
        result["truth"] = {
            "matched_items": n,
            "label": {**prf(tp, fp, fn), "accuracy": (exact / n) if n else None},
            "category": {"accuracy": (sum(v for (e, p), v in cat_conf.items() if e == p) / total_cat) if total_cat else None,
                         "per_class": cats_eval,
                         "confusion": [{"expected": e, "predicted": p, "count": v} for (e, p), v in sorted(cat_conf.items())]},
            "mistakes": mistakes,
        }
    result["_rows"] = rows
    return result


# ---------------------------------------------------------------------------
# 出力
# ---------------------------------------------------------------------------

def pct(x: Optional[float]) -> str:
    return "-" if x is None else f"{100 * x:.1f}%"


def write_outputs(result: dict, outdir: Path, meta: dict) -> None:
    outdir.mkdir(parents=True, exist_ok=True)
    rows = result["_rows"]

    with open(outdir / "items.csv", "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(["検索語", "タイトル", "itemNumber", "抽出した巻", "巻キー", "抽出規則", "種別", "分類", "特装等",
                    "推定シリーズ", "seriesName(叢書名)", "発売日", "出版社", "正解の巻", "正解の分類", "判定"])
        for r in rows:
            it, p, t = r["item"], r["parsed"], r.get("truth")
            judge = ""
            if t:
                ok_label = label_key(p.label) == label_key(t.expected_label)
                ok_cat = (t.expected_category is None) or t.expected_category == p.category
                judge = "OK" if ok_label and ok_cat else "NG"
            w.writerow([r["query"], it["title"], it["itemNumber"], p.label, label_key(p.label) or "", p.rule, p.kind,
                        CATEGORY_JA[p.category], "○" if p.special else "", p.base_title, it.get("seriesName", ""),
                        it.get("salesDate", ""), it.get("publisherName", ""),
                        (t.expected_label or "") if t else "", CATEGORY_JA.get(t.expected_category or "", "") if t else "", judge])

    with open(outdir / "summary.csv", "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(["検索語", "APIの総件数", "総ページ数", "取得ページ数", "取得件数", "打ち切り", "API上限到達",
                    "巻として扱う商品", "巻番号が取れた", "抽出率", "同じ巻が複数（本編）"])
        for q in result["per_query"]:
            w.writerow([q["query"], q["api_count"], q["page_count"], q["pages_fetched"], q["fetched"],
                        "はい" if q["truncated"] else "", "はい" if q["api_limit_hit"] else "",
                        q["volume_items"], q["extracted"], pct(q["extraction_rate"]), ",".join(q["duplicate_main_labels"])])

    data = {k: v for k, v in result.items() if k != "_rows"}
    data["meta"] = meta
    (outdir / "metrics.json").write_text(json.dumps(data, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
    (outdir / "report.md").write_text(render_report(result, meta), encoding="utf-8")


def render_report(result: dict, meta: dict) -> str:
    L: list[str] = []
    o = result["overall"]
    L += ["# 楽天Kobo API 巻番号取得の検証レポート", "",
          f"- 実行日時：{meta.get('run_at')}",
          f"- データ：{meta.get('source')}",
          f"- APIキーの送り方：{meta.get('key_transport')}（キーの値はこのレポートに含めていません）",
          f"- 1検索あたりの最大ページ数：{meta.get('max_pages')}（1ページ{HITS_PER_PAGE}件）", "",
          "## 全体", "",
          "| 項目 | 値 |", "| --- | --- |",
          f"| 取得した商品 | {o['items']} |",
          f"| 巻として扱う商品（単話・分冊・セットを除く） | {o['volume_items']} |",
          f"| 巻番号が取れた | {o['extracted']} |",
          f"| **抽出率**（取れた割合。正しいかどうかは別） | **{pct(o['extraction_rate'])}** |", ""]
    if "truth" in result:
        t = result["truth"]
        lb = t["label"]
        L += ["## 正解データとの照合", "",
              f"照合できた商品：{t['matched_items']}件", "",
              "| 指標 | 値 | 意味 |", "| --- | --- | --- |",
              f"| **正解率** | **{pct(lb['accuracy'])}** | 巻番号（取れない＝空 を含む）が正解と一致した割合 |",
              f"| 適合率 | {pct(lb['precision'])} | 巻番号を出したもののうち、正しかった割合 |",
              f"| 再現率 | {pct(lb['recall'])} | 正解に巻番号があるもののうち、正しく取れた割合 |",
              f"| F1 | {pct(lb['f1'])} | 適合率と再現率の調和平均 |", "",
              f"分類の正解率：{pct(t['category']['accuracy'])}", ""]
        if t["category"]["per_class"]:
            L += ["| 分類 | 適合率 | 再現率 | 正解(TP) | 誤検出(FP) | 見逃し(FN) |", "| --- | --- | --- | --- | --- | --- |"]
            for c, m in t["category"]["per_class"].items():
                L.append(f"| {CATEGORY_JA[c]} | {pct(m['precision'])} | {pct(m['recall'])} | {m['tp']} | {m['fp']} | {m['fn']} |")
            L.append("")
        if t["mistakes"]:
            L += ["### 誤判定", "", "| 検索語 | タイトル | 判定 | 正解 | 規則 |", "| --- | --- | --- | --- | --- |"]
            for m in t["mistakes"][:200]:
                L.append(f"| {esc_md(m['query'])} | {esc_md(m['title'])} | {esc_md(m['predicted'] or '（なし）')} | {esc_md(m['expected'] or '（なし）')} | {m['rule']} |")
            L.append("")
    L += ["## 検索語ごと", "",
          "| 検索語 | 総件数 | 取得 | ページ | 打ち切り | 抽出率 | 単話 | 分冊 | 特装 | 外伝 | コミカライズ | 続編 | セット |",
          "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"]
    for q in result["per_query"]:
        c = q["categories"]
        trunc = "API上限" if q["api_limit_hit"] else ("はい" if q["truncated"] else "")
        L.append(f"| {esc_md(q['query'])} | {q['api_count']} | {q['fetched']} | {q['pages_fetched']}/{q['page_count']} | {trunc} | "
                 f"{pct(q['extraction_rate'])} | {c.get('episode', 0)} | {c.get('split', 0)} | {c.get('special', 0)} | "
                 f"{c.get('spinoff', 0)} | {c.get('comicalize', 0)} | {c.get('sequel', 0)} | {c.get('bundle', 0)} |")
    L.append("")
    if any(q["truncated"] for q in result["per_query"]):
        L += ["> 打ち切りのある検索語は、全件を取れていません。`--pages` を増やすか、検索語を絞ってください。"
              "API の page 上限（100ページ＝3000件）に達した場合は、それ以上は取得できません。", ""]

    # あいまいな結果
    rows = result["_rows"]
    unparsed = [r for r in rows if r["parsed"].kind == "volume" and not r["parsed"].label]
    tail = [r for r in rows if r["parsed"].rule == "末尾数字"]
    dup = [(q["query"], q["duplicate_main_labels"]) for q in result["per_query"] if q["duplicate_main_labels"]]
    L += ["## 確認が必要な結果", "",
          f"### 巻番号が取れなかった商品（{len(unparsed)}件）", ""]
    L += [f"- {esc_md(r['item']['title'])}（{esc_md(r['query'])}）" for r in unparsed[:100]] or ["- なし"]
    L += ["", f"### 末尾の数字だけで巻と判定した商品（{len(tail)}件）", "",
          "副題の数字を巻と取り違えている可能性があります。", ""]
    L += [f"- {esc_md(r['item']['title'])} → {r['parsed'].label}" for r in tail[:100]] or ["- なし"]
    L += ["", "### 同じ巻番号の本編が複数ある検索語", "", "別作品の混入か、版違いの可能性があります。", ""]
    L += [f"- {esc_md(q)}：{', '.join(ls)}" for q, ls in dup] or ["- なし"]
    L += ["", "## 判断の目安", "",
          "- 正解率・再現率が 90% 以上 → 検索して登録する流れを作り込む価値あり",
          "- 60〜90% → 候補を出してユーザーが直す画面が必須",
          "- 60% 未満 → 手入力とまとめて入力を中心にする",
          "- 抽出率が高くても正解率が低い場合は、副題の数字などを取り違えている。誤判定の一覧を確認する", ""]
    return "\n".join(L)


def esc_md(s: str) -> str:
    return str(s).replace("|", "\\|").replace("\n", " ")


# ---------------------------------------------------------------------------
# セルフテスト（APIキー不要）：共有の正解表と一致するか
# ---------------------------------------------------------------------------

FIXTURES = Path(__file__).resolve().parent.parent / "fixtures"


def selftest() -> int:
    failures = 0
    label_cases = json.loads((FIXTURES / "volume-label-cases.json").read_text(encoding="utf-8"))["cases"]
    for c in label_cases:
        ident, err = parse_volume_label(c["input"])
        good = (ident is not None) == c["ok"] and (not ident or (ident.key, ident.label, ident.group, ident.value) == (c["key"], c["label"], c["group"], float(c["value"])))
        failures += not good
        if not good:
            print(f"NG ラベル {c['input']!r}: {ident or err}")
    title_cases = json.loads((FIXTURES / "volume-title-cases.json").read_text(encoding="utf-8"))["cases"]
    for c in title_cases:
        p = parse_title(c["title"])
        got = ((p.label or None), p.kind, p.category, p.special)
        want = (c["label"], c["kind"], c["category"], c["special"])
        failures += got != want
        if got != want:
            print(f"NG タイトル {c['title']!r}: {got} != {want}")
    total = len(label_cases) + len(title_cases)
    print(f"{total - failures}/{total} 件が想定どおり（ラベル{len(label_cases)}件・タイトル{len(title_cases)}件）")
    return 0 if failures == 0 else 1


# ---------------------------------------------------------------------------

def load_raw_dir(d: Path) -> list[SearchRecord]:
    recs = []
    for f in sorted(d.glob("*.json")):
        j = json.loads(f.read_text(encoding="utf-8"))
        pages = j.get("pages", [])
        it = iter(pages)
        rec = search(j["query"], Config("", ""), max_pages=len(pages) or 1, fetch=lambda _p: next(it, {"Items": [], "pageCount": 0}),
                     sleep=lambda _s: None, log=lambda *_a: None)
        recs.append(rec)
    if not recs:
        raise SystemExit(f"{d} に保存した応答（*.json）がありません")
    return recs


def slug(s: str) -> str:
    return re.sub(r"[^\w\-]+", "_", s)[:60] or "query"


def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="楽天Kobo APIで巻番号がどれだけ正しく取れるか検証する")
    ap.add_argument("titles", nargs="*", help="検索する作品名")
    ap.add_argument("-f", "--file", help="作品名を1行ずつ書いたテキストファイル（#で始まる行は無視）")
    ap.add_argument("--pages", type=int, default=5, help="1作品あたりの最大ページ数（1ページ30件, 既定5, 最大100）")
    ap.add_argument("-o", "--out", default="out", help="出力フォルダ（既定 out）")
    ap.add_argument("--truth", help="正解データCSV（itemNumber/title, expected_label, expected_category）")
    ap.add_argument("--save-raw", action="store_true", help="APIの応答を out/raw に保存する（キーは含まない）")
    ap.add_argument("--from-raw", help="保存した応答のフォルダから評価する（APIを呼ばない）")
    ap.add_argument("--key-in-query", action="store_true", help="accessKey をURLにも付ける（ヘッダーで通らない場合だけ）")
    ap.add_argument("--selftest", action="store_true", help="APIを使わずに解析規則だけ試す")
    a = ap.parse_args(argv)

    if a.selftest:
        return selftest()

    outdir = Path(a.out)
    truth = None
    if a.truth:
        by_item, by_title, problems = load_truth(Path(a.truth))
        for p in problems:
            print("正解データ:", p, file=sys.stderr)
        truth = (by_item, by_title)

    run_at = _dt.datetime.now().astimezone().isoformat(timespec="seconds")
    if a.from_raw:
        records = load_raw_dir(Path(a.from_raw))
        meta = {"run_at": run_at, "source": f"保存した応答（{a.from_raw}）", "key_transport": "（APIを呼んでいない）", "max_pages": "-"}
    else:
        titles = list(a.titles)
        if a.file:
            with open(a.file, encoding="utf-8") as f:
                titles += [ln.strip() for ln in f if ln.strip() and not ln.lstrip().startswith("#")]
        if not titles:
            ap.error("作品名を指定してください（例: python3 kobo_volume_check.py \"作品名\"）")
        app_id = os.environ.get("RAKUTEN_APP_ID", "")
        access_key = os.environ.get("RAKUTEN_ACCESS_KEY", "")
        if not app_id or not access_key:
            print("環境変数 RAKUTEN_APP_ID と RAKUTEN_ACCESS_KEY を設定してください。", file=sys.stderr)
            return 2
        cfg = Config(app_id, access_key, os.environ.get("RAKUTEN_REFERER") or None, a.key_in_query)
        max_pages = max(1, min(a.pages, API_MAX_PAGE))
        records = []
        try:
            for i, q in enumerate(titles):
                if i:
                    time.sleep(cfg.wait_sec)
                records.append(search(q, cfg, max_pages, fetch=lambda p: call_api(p, cfg), log=lambda m: print(m, file=sys.stderr)))
        except ApiError as e:
            print(f"\nAPIエラー {e.status} {e.code}: {e.message}\n{hint_for(e)}", file=sys.stderr)
            return 1
        meta = {"run_at": run_at, "source": "楽天Kobo電子書籍検索API", "max_pages": max_pages,
                "key_transport": "ヘッダー＋クエリ（--key-in-query）" if a.key_in_query else "ヘッダー（accessKey）のみ"}
        if a.save_raw:
            raw = outdir / "raw"
            raw.mkdir(parents=True, exist_ok=True)
            for r in records:
                text = json.dumps({"query": r.query, "saved_at": run_at, "pages": r.raw_pages}, ensure_ascii=False, indent=1)
                (raw / f"{slug(r.query)}.json").write_text(mask(text, [access_key, app_id]), encoding="utf-8")

    result = evaluate(records, truth)
    write_outputs(result, outdir, meta)
    o = result["overall"]
    print(f"\n抽出率 {pct(o['extraction_rate'])}（{o['extracted']}/{o['volume_items']}）")
    if "truth" in result:
        lb = result["truth"]["label"]
        print(f"正解率 {pct(lb['accuracy'])}・適合率 {pct(lb['precision'])}・再現率 {pct(lb['recall'])}（照合 {result['truth']['matched_items']}件）")
    for q in result["per_query"]:
        if q["truncated"]:
            print(f"注意：「{q['query']}」は {q['page_count']}ページ中 {q['pages_fetched']}ページで打ち切りました", file=sys.stderr)
    print(f"レポート: {outdir / 'report.md'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
