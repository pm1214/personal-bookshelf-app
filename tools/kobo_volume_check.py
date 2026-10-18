#!/usr/bin/env python3
"""
楽天Kobo電子書籍検索API 巻番号取得の検証スクリプト

目的:
  手持ちの作品名で検索し、「シリーズ名」と「巻番号」がどの程度
  自動で取れるかを数字で確かめる。

使い方:
  1. 楽天ウェブサービス(https://webservice.rakuten.co.jp/)でアプリを作成し、
     applicationId と accessKey を控える。アプリ設定の「WebサイトURL」も登録する。
  2. 環境変数を設定する（macOS / Linux の例）:
       export RAKUTEN_APP_ID="xxxxxxxx"
       export RAKUTEN_ACCESS_KEY="xxxxxxxx"
       export RAKUTEN_REFERER="https://example.com/"   # 登録したWebサイトURL
  3. 実行:
       python3 kobo_volume_check.py "作品名1" "作品名2"
     または titles.txt（1行1作品）を用意して:
       python3 kobo_volume_check.py -f titles.txt

  APIキー無しで巻番号パーサだけ試す:
       python3 kobo_volume_check.py --selftest

出力（outフォルダ）:
  items.csv    取得した全商品と、抽出した巻番号・判定
  summary.csv  作品ごとの集計（巻番号の取得率、抜けている番号など）
  画面にも集計表を表示する。

必要なもの: Python 3.9以上。追加ライブラリ不要（標準ライブラリのみ）。
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from dataclasses import dataclass, field

ENDPOINT = "https://openapi.rakuten.co.jp/services/api/Kobo/EbookSearch/20170426"
WAIT_SEC = 1.0  # リクエスト間隔。短時間の大量アクセスは一時停止の対象になる

# ---------------------------------------------------------------------------
# 巻番号パーサ
# ---------------------------------------------------------------------------

KANJI_DIGITS = {"〇": 0, "零": 0, "一": 1, "二": 2, "三": 3, "四": 4, "五": 5,
                "六": 6, "七": 7, "八": 8, "九": 9}
UPPER_LOWER = {"上": 1, "中": 2, "下": 3, "前": 1, "後": 2}

# 単話・分冊など「1巻」単位ではない商品
EPISODE_RE = re.compile(r"(単話|分冊|話売り|第\s*\d+\s*話|\d+\s*話|連載版|Episode|#\d+)", re.I)
# 特装版・限定版など
SPECIAL_RE = re.compile(r"(特装|限定|特別|デラックス|DX版|完全版|新装|愛蔵|カラー版|フルカラー)")
# 合本・セット
BUNDLE_RE = re.compile(r"(合本|セット|まとめ買い|全\d+巻|BOX|\d+\s*[〜~\-－]\s*\d+\s*巻)", re.I)
# タイトル末尾の飾り（【電子特典付き】など）
NOISE_RE = re.compile(r"[【\[][^】\]]*[】\]]")


def kanji_to_int(s: str) -> int | None:
    """一〜九十九程度の漢数字を整数に。"""
    if not s:
        return None
    if all(c in KANJI_DIGITS for c in s):  # 「一二」形式
        return int("".join(str(KANJI_DIGITS[c]) for c in s))
    m = re.fullmatch(r"([一二三四五六七八九])?十([一二三四五六七八九])?", s)
    if m:
        tens = KANJI_DIGITS[m.group(1)] if m.group(1) else 1
        ones = KANJI_DIGITS[m.group(2)] if m.group(2) else 0
        return tens * 10 + ones
    return None


@dataclass
class Parsed:
    volume: float | None      # 並び順用の数値（10.5など）
    label: str                # 表示用（"10", "10.5", "上"）
    rule: str                 # どの規則で取れたか
    kind: str                 # volume / episode / bundle
    special: bool             # 特装版などか
    base_title: str           # 巻表記を取り除いたタイトル（シリーズ推定用）


def normalize(s: str) -> str:
    s = unicodedata.normalize("NFKC", s or "")
    return re.sub(r"\s+", " ", s).strip()


def parse_volume(title: str) -> Parsed:
    raw = normalize(title)
    special = bool(SPECIAL_RE.search(raw))
    if BUNDLE_RE.search(raw):
        kind = "bundle"
    elif EPISODE_RE.search(raw):
        kind = "episode"
    else:
        kind = "volume"

    t = NOISE_RE.sub("", raw).strip()
    # 数字だけではない括弧（出版社・レーベル名など）を除く: (ジャンプコミックスDIGITAL)
    t = re.sub(r"[(（](?![\s\d.上中下前後]+[)）])[^)）]*[)）]", " ", t)
    # 版の表記を除く: 特装版 / 限定版 / 通常版 など
    t = re.sub(r"\S*(特装|限定|特別|通常|デラックス|完全|新装|愛蔵|カラー)版", " ", t)
    t = normalize(t)

    if kind == "bundle":  # セット・合本は巻を持たない
        return Parsed(None, "", "セット", kind, special, clean_base(BUNDLE_RE.sub("", t)))

    patterns = [
        # 第10巻 / 10巻 / 第十巻
        ("巻", r"第?\s*(\d+(?:\.\d+)?)\s*巻"),
        ("巻(漢数字)", r"第?\s*([一二三四五六七八九十〇]+)\s*巻"),
        # (10) / （10） ※出版社の括弧 (ジャンプコミックス) は数字でないので当たらない
        ("括弧", r"[(（]\s*(\d+(?:\.\d+)?)\s*[)）]"),
        # Vol.10 / vol 10 / VOLUME 10
        ("Vol", r"vol(?:ume)?\.?\s*(\d+(?:\.\d+)?)"),
        # 上・中・下 / 前編・後編
        ("上下", r"(?:^|[\s(（])([上中下前後])(?:巻|編)?(?:$|[\s)）])"),
        # 末尾の数字: 「作品名 10」
        ("末尾数字", r"\s(\d+(?:\.\d+)?)\s*$"),
    ]
    for rule, pat in patterns:
        m = re.search(pat, t, re.I)
        if not m:
            continue
        g = m.group(1)
        if rule == "巻(漢数字)":
            n = kanji_to_int(g)
            if n is None:
                continue
            vol, label = float(n), str(n)
        elif rule == "上下":
            vol, label = float(UPPER_LOWER[g]), g
        else:
            vol, label = float(g), g
        # 年号や話数の誤検出を避ける
        if vol > 300:
            continue
        base = (t[:m.start()] + " " + t[m.end():]).strip()
        return Parsed(vol, label, rule, kind, special, clean_base(base))
    return Parsed(None, "", "取れず", kind, special, clean_base(t))


def clean_base(s: str) -> str:
    s = re.sub(r"[(（][^)）]*[)）]", "", s)   # (ジャンプコミックス) など
    s = re.sub(r"[\s:：・\-－]+$", "", s)
    return normalize(s)


# ---------------------------------------------------------------------------
# API 呼び出し
# ---------------------------------------------------------------------------

def call_api(params: dict, app_id: str, access_key: str, referer: str | None) -> dict:
    q = {"applicationId": app_id, "accessKey": access_key,
         "format": "json", "formatVersion": 2, **params}
    url = ENDPOINT + "?" + urllib.parse.urlencode(q)
    headers = {"User-Agent": "kobo-volume-check/1.0", "accessKey": access_key}
    if referer:
        headers["Referer"] = referer
        headers["Origin"] = referer.rstrip("/")
    req = urllib.request.Request(url, headers=headers)
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")
            if e.code == 429 and attempt < 2:
                time.sleep(5 * (attempt + 1))
                continue
            raise SystemExit(f"\nAPIエラー {e.code}: {body}\n{hint_for(body)}")
        except urllib.error.URLError as e:
            raise SystemExit(f"\n接続できませんでした: {e.reason}")
    raise SystemExit("リトライ上限に達しました")


def hint_for(body: str) -> str:
    if "REFERRER_MISSING" in body or "REFERER" in body.upper():
        return "→ RAKUTEN_REFERER に、アプリ設定で登録したWebサイトURLを入れてください。"
    if "accessKey" in body or "access_key" in body.lower():
        return "→ RAKUTEN_ACCESS_KEY を確認してください。"
    if "applicationId" in body or "wrong_parameter" in body:
        return "→ RAKUTEN_APP_ID と検索語を確認してください。"
    return ""


def search_all(title: str, cfg, max_pages: int) -> list[dict]:
    items: list[dict] = []
    for page in range(1, max_pages + 1):
        data = call_api({"title": title, "hits": 30, "page": page,
                         "sort": "+releaseDate"},
                        cfg.app_id, cfg.access_key, cfg.referer)
        got = data.get("Items") or data.get("items") or []
        # formatVersion=1 の形にも対応
        got = [g.get("Item", g.get("item", g)) if isinstance(g, dict) else g for g in got]
        items.extend(got)
        page_count = data.get("pageCount", 1)
        print(f"  {title}: {page}/{page_count}ページ, 累計{len(items)}件", file=sys.stderr)
        if page >= page_count:
            break
        time.sleep(WAIT_SEC)
    time.sleep(WAIT_SEC)
    return items


# ---------------------------------------------------------------------------
# 集計
# ---------------------------------------------------------------------------

@dataclass
class Summary:
    query: str
    total: int = 0
    volumes: int = 0
    episodes: int = 0
    bundles: int = 0
    specials: int = 0
    with_series_name: int = 0
    vol_parsed: int = 0
    series_names: set = field(default_factory=set)
    nums: set = field(default_factory=set)
    dup_nums: set = field(default_factory=set)


def missing_numbers(nums: set) -> list[int]:
    ints = sorted({int(n) for n in nums if n == int(n) and n >= 1})
    if not ints:
        return []
    return [n for n in range(1, ints[-1] + 1) if n not in ints]


def run(titles: list[str], cfg, max_pages: int, outdir: str) -> None:
    os.makedirs(outdir, exist_ok=True)
    item_rows, summaries = [], []
    for q in titles:
        items = search_all(q, cfg, max_pages)
        s = Summary(q, total=len(items))
        seen = defaultdict(int)
        for it in items:
            title = it.get("title", "")
            series = normalize(it.get("seriesName", ""))
            p = parse_volume(title)
            if series:
                s.with_series_name += 1
                s.series_names.add(series)
            s.specials += p.special
            if p.kind == "episode":
                s.episodes += 1
            elif p.kind == "bundle":
                s.bundles += 1
            else:
                s.volumes += 1
                if p.volume is not None:
                    s.vol_parsed += 1
                    if not p.special:
                        seen[p.volume] += 1
                        s.nums.add(p.volume)
            item_rows.append({
                "検索語": q, "タイトル": title, "seriesName": series,
                "subTitle": it.get("subTitle", ""),
                "抽出した巻": p.label, "並び順": p.volume if p.volume is not None else "",
                "抽出規則": p.rule, "種別": p.kind, "特装等": "○" if p.special else "",
                "推定シリーズ": p.base_title, "発売日": it.get("salesDate", ""),
                "出版社": it.get("publisherName", ""), "itemNumber": it.get("itemNumber", ""),
                "URL": it.get("itemUrl", ""),
            })
        s.dup_nums = {n for n, c in seen.items() if c > 1}
        summaries.append(s)

    write_csv(os.path.join(outdir, "items.csv"), item_rows)
    sum_rows = [summary_row(s) for s in summaries]
    write_csv(os.path.join(outdir, "summary.csv"), sum_rows)
    print_table(sum_rows)
    print(f"\n詳細: {os.path.join(outdir, 'items.csv')}")
    print(f"集計: {os.path.join(outdir, 'summary.csv')}")


def pct(a: int, b: int) -> str:
    return f"{100 * a / b:.0f}%" if b else "-"


def summary_row(s: Summary) -> dict:
    ints = sorted(int(n) for n in s.nums if n == int(n))
    miss = missing_numbers(s.nums)
    return {
        "検索語": s.query,
        "取得件数": s.total,
        "巻単位": s.volumes,
        "単話・分冊": s.episodes,
        "合本・セット": s.bundles,
        "特装等": s.specials,
        "seriesNameあり": pct(s.with_series_name, s.total),
        "巻番号取得率(巻単位中)": pct(s.vol_parsed, s.volumes),
        "取れた巻の範囲": f"{ints[0]}〜{ints[-1]}" if ints else "",
        "抜けている番号": ",".join(map(str, miss[:20])) + ("…" if len(miss) > 20 else ""),
        "重複した番号": ",".join(str(int(n)) if n == int(n) else str(n) for n in sorted(s.dup_nums)),
        "seriesNameの種類数": len(s.series_names),
    }


def write_csv(path: str, rows: list[dict]) -> None:
    if not rows:
        return
    # Excelで文字化けしないよう BOM付きUTF-8
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)


def print_table(rows: list[dict]) -> None:
    cols = ["検索語", "取得件数", "巻単位", "単話・分冊", "seriesNameあり",
            "巻番号取得率(巻単位中)", "取れた巻の範囲", "抜けている番号"]
    print("\n=== 集計 ===")
    for r in rows:
        print("\n".join(f"  {c}: {r[c]}" for c in cols))
        print("  ---")
    print("""
読み方:
  巻番号取得率が 90%以上 → 検索して登録する流れを作り込む価値あり
  50〜90%               → 候補を出してユーザーが直すUIが必須
  50%未満               → 手入力と範囲入力（1-10 kindle）を中心にする
  seriesNameあり が低い → シリーズのまとめはタイトルからの推定に頼ることになる
  抜けている番号        → APIに無い巻か、パーサが取りこぼした巻。items.csv で確認""")


# ---------------------------------------------------------------------------
# セルフテスト（APIキー不要）
# ---------------------------------------------------------------------------

SELFTEST = [
    ("作品名（10）", 10, "volume"),
    ("作品名 10 (ジャンプコミックスDIGITAL)", 10, "volume"),
    ("作品名 第10巻", 10, "volume"),
    ("作品名 第十二巻", 12, "volume"),
    ("作品名10巻【電子特典付き】", 10, "volume"),
    ("作品名 Vol.3", 3, "volume"),
    ("作品名(１０．５)", 10.5, "volume"),
    ("作品名 上", 1, "volume"),
    ("作品名（下）", 3, "volume"),
    ("作品名 3 特装版", 3, "volume"),
    ("作品名【単話版】 第25話", None, "episode"),
    ("作品名 分冊版 (12)", 12, "episode"),
    ("作品名 1-10巻セット", None, "bundle"),
    ("作品名 合本版", None, "bundle"),
    ("作品名", None, "volume"),
    ("2024年の作品名", None, "volume"),
]


def selftest() -> int:
    ok = 0
    for title, want_vol, want_kind in SELFTEST:
        p = parse_volume(title)
        good = p.volume == want_vol and p.kind == want_kind
        ok += good
        mark = "OK " if good else "NG "
        print(f"{mark} {title!r:40} -> 巻={p.label or '-':5} 種別={p.kind:8} "
              f"特装={'○' if p.special else '-'} 規則={p.rule:8} シリーズ推定={p.base_title!r}")
    print(f"\n{ok}/{len(SELFTEST)} 件が想定どおり")
    return 0 if ok == len(SELFTEST) else 1


# ---------------------------------------------------------------------------

@dataclass
class Config:
    app_id: str
    access_key: str
    referer: str | None


def main() -> int:
    ap = argparse.ArgumentParser(description="楽天Kobo APIで巻番号がどれだけ取れるか検証する")
    ap.add_argument("titles", nargs="*", help="検索する作品名")
    ap.add_argument("-f", "--file", help="作品名を1行ずつ書いたテキストファイル")
    ap.add_argument("--pages", type=int, default=5, help="1作品あたりの最大ページ数（1ページ30件, 既定5）")
    ap.add_argument("-o", "--out", default="out", help="出力フォルダ（既定 out）")
    ap.add_argument("--selftest", action="store_true", help="APIを使わずに巻番号パーサだけ試す")
    a = ap.parse_args()

    if a.selftest:
        return selftest()

    titles = list(a.titles)
    if a.file:
        with open(a.file, encoding="utf-8") as f:
            titles += [ln.strip() for ln in f if ln.strip() and not ln.startswith("#")]
    if not titles:
        ap.error("作品名を指定してください（例: python3 kobo_volume_check.py \"作品名\"）")

    app_id = os.environ.get("RAKUTEN_APP_ID", "")
    access_key = os.environ.get("RAKUTEN_ACCESS_KEY", "")
    if not app_id or not access_key:
        print("環境変数 RAKUTEN_APP_ID と RAKUTEN_ACCESS_KEY を設定してください。", file=sys.stderr)
        return 2
    cfg = Config(app_id, access_key, os.environ.get("RAKUTEN_REFERER"))
    run(titles, cfg, max(1, min(a.pages, 100)), a.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
