"""
kobo_volume_check.py のテスト（API には接続しない）。

実行: python3 -m unittest discover -s tools -v
"""
import io
import json
import sys
import tempfile
import unittest
import urllib.error
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import kobo_volume_check as k  # noqa: E402

FIX = Path(__file__).resolve().parent.parent / "fixtures"
KEY = "SECRET-ACCESS-KEY-1234"
APP = "APPID-5678"


def item(title, n, **extra):
    d = {"title": title, "itemNumber": f"T{n:05d}", "author": "架空 太郎", "publisherName": "架空出版",
         "seriesName": "架空コミックスDIGITAL", "salesDate": "2020年01月01日"}
    d.update(extra)
    return d


class FakeResp(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class FakeOpener:
    """urlopen の代わり。送られたリクエストを記録し、用意した応答を順に返す。"""

    def __init__(self, responses):
        self.responses = list(responses)
        self.requests = []

    def __call__(self, req, timeout=None):
        self.requests.append(req)
        status, body = self.responses.pop(0)
        raw = json.dumps(body).encode("utf-8")
        if status == 200:
            return FakeResp(raw)
        raise urllib.error.HTTPError(req.full_url, status, "err", {}, io.BytesIO(raw))


class SharedCases(unittest.TestCase):
    def test_label_cases_match_typescript(self):
        for c in json.loads((FIX / "volume-label-cases.json").read_text(encoding="utf-8"))["cases"]:
            with self.subTest(c["input"]):
                ident, err = k.parse_volume_label(c["input"])
                self.assertEqual(ident is not None, c["ok"], err)
                if ident:
                    self.assertEqual((ident.key, ident.label, ident.group, ident.value), (c["key"], c["label"], c["group"], float(c["value"])))

    def test_title_cases_match_typescript(self):
        for c in json.loads((FIX / "volume-title-cases.json").read_text(encoding="utf-8"))["cases"]:
            with self.subTest(c["title"]):
                p = k.parse_title(c["title"])
                self.assertEqual((p.label or None, p.kind, p.category, p.special), (c["label"], c["kind"], c["category"], c["special"]))

    def test_limits_match_typescript(self):
        src = (Path(__file__).resolve().parent.parent / "src" / "limits.ts").read_text(encoding="utf-8")
        self.assertIn(f"maxVolumeNumber: {k.MAX_VOLUME_NUMBER},", src)
        self.assertIn(f"maxVolumeDecimals: {k.MAX_VOLUME_DECIMALS},", src)
        self.assertIn(f"maxLabelLength: {k.MAX_LABEL_LENGTH},", src)

    def test_special_numbers(self):
        self.assertEqual(k.label_key("10.5"), "n:10.5")
        self.assertEqual(k.label_key("10.50"), "n:10.5")
        self.assertNotEqual(k.label_key("10.5"), k.label_key("10.501"))
        self.assertNotEqual(k.label_key("上"), k.label_key("1"))
        self.assertEqual(k.label_key("0"), "n:0")
        self.assertIsNone(k.parse_volume_label("999999999")[0])


class ApiKeyHandling(unittest.TestCase):
    def cfg(self, **kw):
        return k.Config(APP, KEY, referer="https://example.invalid/app", wait_sec=0, **kw)

    def test_key_sent_in_header_not_url_by_default(self):
        op = FakeOpener([(200, {"count": 1, "pageCount": 1, "Items": [item("a 1", 1)]})])
        k.call_api({"title": "a"}, self.cfg(), opener=op)
        req = op.requests[0]
        self.assertNotIn(KEY, req.full_url)
        self.assertEqual(req.get_header("Accesskey"), KEY)
        self.assertEqual(req.get_header("Referer"), "https://example.invalid/app")
        self.assertEqual(req.get_header("Origin"), "https://example.invalid")
        q = urllib.parse.parse_qs(urllib.parse.urlparse(req.full_url).query)
        self.assertEqual(q["applicationId"], [APP])
        self.assertTrue(req.full_url.startswith("https://openapi.rakuten.co.jp/services/api/Kobo/EbookSearch/20170426?"))

    def test_key_in_query_only_when_requested(self):
        op = FakeOpener([(200, {"Items": []})])
        k.call_api({"title": "a"}, self.cfg(key_in_query=True), opener=op)
        self.assertIn("accessKey=" + KEY, op.requests[0].full_url)

    def test_error_messages_never_contain_key(self):
        body = {"error": "wrong_parameter", "error_description": f"accessKey {KEY} is not valid for {APP}"}
        op = FakeOpener([(400, body)])
        with self.assertRaises(k.ApiError) as cm:
            k.call_api({"title": "a"}, self.cfg(), opener=op)
        self.assertNotIn(KEY, str(cm.exception))
        self.assertNotIn(APP, str(cm.exception))
        self.assertIn("***", cm.exception.message)
        self.assertIn("--key-in-query", k.hint_for(cm.exception))

    def test_not_found_is_empty_and_429_is_retried(self):
        op = FakeOpener([(404, {"error": "not_found", "error_description": "not found"})])
        self.assertEqual(k.call_api({"title": "a"}, self.cfg(), opener=op)["Items"], [])
        sleeps = []
        op = FakeOpener([(429, {"error": "too_many_requests"}), (200, {"Items": [item("a 1", 1)], "pageCount": 1})])
        r = k.call_api({"title": "a"}, self.cfg(), opener=op, sleep=sleeps.append)
        self.assertEqual(len(r["Items"]), 1)
        self.assertEqual(sleeps, [5])


class SearchRecording(unittest.TestCase):
    def run_search(self, pages, max_pages):
        it = iter(pages)
        return k.search("q", k.Config("", "", wait_sec=0), max_pages, fetch=lambda p: next(it), sleep=lambda s: None, log=lambda m: None)

    def test_counts_and_truncation(self):
        p1 = {"count": 95, "pageCount": 4, "Items": [item(f"x {i}", i) for i in range(1, 31)]}
        p2 = {"count": 95, "pageCount": 4, "Items": [item(f"x {i}", i) for i in range(30, 60)]}  # 1件重複
        r = self.run_search([p1, p2], max_pages=2)
        self.assertEqual((r.api_count, r.page_count, r.pages_fetched, r.fetched, r.duplicates_dropped), (95, 4, 2, 59, 1))
        self.assertTrue(r.truncated)
        self.assertFalse(r.api_limit_hit)

    def test_api_page_limit(self):
        p = {"count": 5000, "pageCount": 167, "Items": [item("x 1", 1)]}
        r = self.run_search([p], max_pages=1)
        self.assertTrue(r.truncated)
        self.assertTrue(r.api_limit_hit)

    def test_all_pages(self):
        r = self.run_search([{"count": 2, "pageCount": 1, "Items": [item("x 1", 1), {"Item": item("x 2", 2)}]}], max_pages=5)
        self.assertEqual((r.fetched, r.truncated), (2, False))


class Evaluation(unittest.TestCase):
    def records(self):
        items = [
            item("星屑ノート（1）", 1), item("星屑ノート（2）", 2), item("星屑ノート 3 特装版", 3),
            item("星屑ノート 4: 二人の約束", 4),          # 副題の数字 → 取れず（正解は 4）
            item("星屑ノート【単話版】 第5話", 5), item("星屑ノート 外伝 (1)", 6), item("星屑ノート 1-3巻セット", 7),
            item("星屑ノート 2024", 8),                    # 年号 → 取れず（正解は巻なし）
            item("星屑ノート THE COMIC（1）", 9),
        ]
        rec = k.SearchRecord("星屑ノート", api_count=9, page_count=1, pages_fetched=1, fetched=len(items), items=items)
        return [rec]

    def truth(self):
        T = k.Truth
        return ({
            "T00001": T("1", "main"), "T00002": T("2", "main"), "T00003": T("3", "special"),
            "T00004": T("4", "main"), "T00005": T(None, "episode"), "T00006": T("1", "spinoff"),
            "T00007": T(None, "bundle"), "T00008": T(None, "main"), "T00009": T("1", "comicalize"),
        }, {})

    def test_extraction_rate_without_truth(self):
        r = k.evaluate(self.records())
        o = r["overall"]
        # 巻として扱う商品：単話・セットを除く7件。取れたのは 1,2,3,外伝1,COMIC1 の5件
        self.assertEqual((o["volume_items"], o["extracted"]), (7, 5))
        self.assertAlmostEqual(o["extraction_rate"], 5 / 7)

    def test_precision_recall_with_truth(self):
        r = k.evaluate(self.records(), self.truth())
        lb = r["truth"]["label"]
        # 予測あり5件はすべて正解（tp=5, fp=0）。正解に巻がある6件のうち4巻だけ取れず（fn=1）
        self.assertEqual((lb["tp"], lb["fp"], lb["fn"]), (5, 0, 1))
        self.assertAlmostEqual(lb["precision"], 1.0)
        self.assertAlmostEqual(lb["recall"], 5 / 6)
        self.assertAlmostEqual(lb["accuracy"], 8 / 9)
        self.assertAlmostEqual(r["truth"]["category"]["accuracy"], 1.0)
        self.assertEqual([m["title"] for m in r["truth"]["mistakes"]], ["星屑ノート 4: 二人の約束"])

    def test_wrong_label_counts_as_fp_and_fn(self):
        recs = self.records()
        truth = self.truth()
        truth[0]["T00002"] = k.Truth("3", "main")
        lb = k.evaluate(recs, truth)["truth"]["label"]
        self.assertEqual((lb["tp"], lb["fp"], lb["fn"]), (4, 1, 2))


class EndToEnd(unittest.TestCase):
    def test_from_raw_with_truth_writes_reports(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            raw = d / "raw"
            raw.mkdir()
            pages = [{"count": 3, "pageCount": 1, "Items": [item("月の庭（1）", 1), item("月の庭（2）", 2), item("月の庭 上", 3)]}]
            (raw / "tsuki.json").write_text(json.dumps({"query": "月の庭", "pages": pages}, ensure_ascii=False), encoding="utf-8")
            truth = d / "truth.csv"
            truth.write_text("﻿itemNumber,expected_label,expected_category\nT00001,1,main\nT00002,2,main\nT00003,上,main\nT99999,あいうえおかきくけこさしすせそたちつてとな,main\n", encoding="utf-8")
            out = d / "out"
            rc = k.main(["--from-raw", str(raw), "--truth", str(truth), "-o", str(out)])
            self.assertEqual(rc, 0)
            for f in ["report.md", "summary.csv", "items.csv", "metrics.json"]:
                self.assertTrue((out / f).exists(), f)
            m = json.loads((out / "metrics.json").read_text(encoding="utf-8"))
            self.assertEqual(m["truth"]["label"]["accuracy"], 1.0)
            report = (out / "report.md").read_text(encoding="utf-8")
            self.assertIn("正解率", report)
            self.assertIn("適合率", report)
            self.assertIn("再現率", report)
            self.assertIn("抽出率", report)

    def test_saved_raw_never_contains_key(self):
        # --save-raw の保存処理で使う mask がキーを消すこと
        text = json.dumps({"x": f"url?accessKey={KEY}&applicationId={APP}"})
        self.assertNotIn(KEY, k.mask(text, [KEY, APP]))

    def test_selftest_passes(self):
        self.assertEqual(k.selftest(), 0)


if __name__ == "__main__":
    unittest.main()
