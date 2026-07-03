"""scraper/main.py の単体テスト。

ネットワーク不要テスト（parse_robots_txt, extract_text, extract_title）と
実URLテスト（/scrape エンドポイント、SCRAPE_TEST_URL env で制御）。
"""
import asyncio
import os
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from main import (
    SCRAPE_BATCH_DELAY,
    SCRAPE_BATCH_SIZE,
    SEARXNG_SAFE_LIMIT,
    app,
    extract_text,
    is_safe_host,
    parse_robots_txt,
    scrape_url_safe,
)
from scrapling.parser import Adaptor


@pytest.fixture
def client():
    return TestClient(app)


# --- parse_robots_txt ---

class TestParseRobotsTxt:
    def test_disallow_paths_from_wildcard_block(self):
        text = """User-agent: *
Disallow: /private
Disallow: /admin/
User-agent: GoogleBot
Disallow: /google-only"""
        rules = parse_robots_txt(text)
        assert "/private" in rules["disallow_paths"]
        assert "/admin/" in rules["disallow_paths"]
        assert "/google-only" not in rules["disallow_paths"]

    def test_empty_robots_txt(self):
        assert parse_robots_txt("")["disallow_paths"] == []

    def test_comments_and_blank_lines_ignored(self):
        text = """# comment

User-agent: *
# inline comment
Disallow: /blocked"""
        assert parse_robots_txt(text)["disallow_paths"] == ["/blocked"]

    def test_empty_disallow_ignored(self):
        text = """User-agent: *
Disallow:"""
        assert parse_robots_txt(text)["disallow_paths"] == []


# --- extract_text / extract_title ---

def make_adaptor(html: str) -> Adaptor:
    return Adaptor(html, url="http://example.com/")


class TestExtractText:
    def test_main_priority_over_article_and_body(self):
        html = """<html><body>
        <main><p>main content</p></main>
        <article><p>article content</p></article>
        </body></html>"""
        text = extract_text(make_adaptor(html))
        assert "main content" in text
        assert "article content" not in text

    def test_article_fallback_when_no_main(self):
        html = """<html><body>
        <article><p>article content</p></article>
        </body></html>"""
        text = extract_text(make_adaptor(html))
        assert "article content" in text

    def test_body_fallback_when_no_main_no_article(self):
        html = """<html><body><p>body content</p></body></html>"""
        text = extract_text(make_adaptor(html))
        assert "body content" in text

    def test_ignore_tags_removed(self):
        html = """<html><body>
        <main>
            <script>alert('x')</script>
            <style>body{color:red}</style>
            <nav>navigation</nav>
            <footer>footer text</footer>
            <p>real content</p>
        </main>
        </body></html>"""
        text = extract_text(make_adaptor(html))
        assert "real content" in text
        assert "alert" not in text
        assert "navigation" not in text
        assert "footer text" not in text

    def test_truncates_at_max_length(self, monkeypatch):
        import main as main_module
        monkeypatch.setattr(main_module, "MAX_CONTENT_LENGTH", 50)
        html = f"<html><body><main><p>{'x' * 200}</p></main></body></html>"
        text = extract_text(make_adaptor(html))
        assert len(text) <= 50

    def test_empty_html_returns_empty(self):
        text = extract_text(make_adaptor("<html><body></body></html>"))
        assert text == ""


class TestExtractTitle:
    def test_title_tag(self):
        from main import extract_title
        html = "<html><head><title>Page Title</title></head><body></body></html>"
        assert extract_title(make_adaptor(html)) == "Page Title"

    def test_og_title_fallback(self):
        from main import extract_title
        html = """<html><head>
        <meta property="og:title" content="OG Title">
        </head><body></body></html>"""
        assert extract_title(make_adaptor(html)) == "OG Title"

    def test_no_title_returns_empty(self):
        from main import extract_title
        html = "<html><body><p>no title here</p></body></html>"
        assert extract_title(make_adaptor(html)) == ""


# --- /scrape endpoint ---

class TestScrapeEndpoint:
    def test_invalid_scheme_returns_400(self, client):
        resp = client.post("/scrape", json={"url": "ftp://example.com"})
        assert resp.status_code == 400

    def test_missing_url_returns_422(self, client):
        # Pydantic バリデーション
        resp = client.post("/scrape", json={})
        assert resp.status_code == 422

    def test_real_url(self, client):
        url = os.environ.get("SCRAPE_TEST_URL")
        if not url:
            pytest.skip("SCRAPE_TEST_URL env not set")
        resp = client.post("/scrape", json={"url": url})
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == 200
        assert data["url"]
        assert isinstance(data["content"], str)
        assert len(data["content"]) > 0


# --- is_safe_host (SSRF protection) ---

class TestIsSafeHost:
    def test_loopback_ipv4_rejected(self):
        assert is_safe_host("127.0.0.1") is False

    def test_loopback_ipv6_rejected(self):
        assert is_safe_host("::1") is False

    def test_private_10_rejected(self):
        assert is_safe_host("10.0.0.1") is False

    def test_private_172_rejected(self):
        assert is_safe_host("172.16.0.1") is False

    def test_private_192_rejected(self):
        assert is_safe_host("192.168.1.1") is False

    def test_link_local_rejected(self):
        assert is_safe_host("169.254.169.254") is False

    def test_unspecified_rejected(self):
        assert is_safe_host("0.0.0.0") is False

    def test_decimal_ip_rejected(self):
        # 3232235521 = 192.0.0.1 → private
        assert is_safe_host("3232235521") is False

    def test_nonexistent_domain_rejected(self):
        # fail-closed: DNS解決失敗は不許可
        assert is_safe_host("nonexistent-xyz-invalid.test") is False

    def test_public_domain_allowed(self):
        # example.com は公開IPに解決されるはず
        assert is_safe_host("example.com") is True


class TestScrapeEndpointSSRF:
    def test_loopback_blocked(self, client):
        resp = client.post("/scrape", json={"url": "http://127.0.0.1:5432/"})
        assert resp.status_code == 400
        assert "private or reserved IP" in resp.json()["error"]

    def test_metadata_endpoint_blocked(self, client):
        resp = client.post("/scrape", json={"url": "http://169.254.169.254/latest/meta-data/"})
        assert resp.status_code == 400
        assert "private or reserved IP" in resp.json()["error"]

    def test_decimal_ip_blocked(self, client):
        resp = client.post("/scrape", json={"url": "http://3232235521/"})
        assert resp.status_code == 400
        assert "private or reserved IP" in resp.json()["error"]


# --- /search endpoint ---

class TestSearchEndpoint:
    def test_empty_query_returns_400(self, client):
        resp = client.post("/search", json={"query": "   "})
        assert resp.status_code == 400
        assert "query is required" in resp.json()["error"]

    def test_missing_query_returns_422(self, client):
        # Pydantic バリデーション
        resp = client.post("/search", json={})
        assert resp.status_code == 422

    def test_searxng_unreachable_returns_502(self, client, monkeypatch):
        # SearXNG が未起動/無効アドレス → 502
        monkeypatch.setenv("SEARXNG_URL", "http://invalid-searxng-host:8080")
        resp = client.post("/search", json={"query": "python programming", "max_results": 3})
        assert resp.status_code == 502
        assert "search failed" in resp.json()["error"]

    def test_real_search(self, client):
        query = os.environ.get("SEARCH_TEST_QUERY")
        if not query:
            pytest.skip("SEARCH_TEST_QUERY env not set")
        resp = client.post("/search", json={"query": query, "max_results": 3})
        assert resp.status_code == 200
        data = resp.json()
        assert data["query"] == query
        assert isinstance(data["results"], list)
        for r in data["results"]:
            assert "url" in r
            assert "title" in r
            assert "snippet" in r
            assert "scraped" in r
            assert "content" in r
            assert "scrape_title" in r


# --- scrape_url_safe (SSRF protection wrapper) ---

class TestScrapeUrlSafe:
    def test_invalid_scheme_returns_empty(self):
        result = asyncio.run(scrape_url_safe("ftp://example.com"))
        assert result == {}

    def test_loopback_blocked_returns_empty(self):
        result = asyncio.run(scrape_url_safe("http://127.0.0.1:5432/"))
        assert result == {}

    def test_metadata_endpoint_blocked_returns_empty(self):
        result = asyncio.run(scrape_url_safe("http://169.254.169.254/latest/meta-data/"))
        assert result == {}


class TestSearchTimeRange:
    """time_range を SearXNG リクエスト params に透過するか検証（httpx をモック）。"""

    @staticmethod
    def _ok_response() -> MagicMock:
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"results": []}
        return mock_resp

    def test_week_passed_to_searxng(self, client):
        mock_get = AsyncMock(return_value=self._ok_response())
        with patch("httpx.AsyncClient.get", mock_get):
            resp = client.post(
                "/search", json={"query": "test", "max_results": 3, "time_range": "week"}
            )
        assert resp.status_code == 200
        params = mock_get.call_args_list[0].kwargs.get("params", {})
        assert params.get("time_range") == "week"

    def test_day_passed_to_searxng(self, client):
        mock_get = AsyncMock(return_value=self._ok_response())
        with patch("httpx.AsyncClient.get", mock_get):
            resp = client.post(
                "/search", json={"query": "test", "max_results": 3, "time_range": "day"}
            )
        assert resp.status_code == 200
        params = mock_get.call_args_list[0].kwargs.get("params", {})
        assert params.get("time_range") == "day"

    def test_none_omits_time_range(self, client):
        mock_get = AsyncMock(return_value=self._ok_response())
        with patch("httpx.AsyncClient.get", mock_get):
            resp = client.post(
                "/search", json={"query": "test", "max_results": 3, "time_range": None}
            )
        assert resp.status_code == 200
        params = mock_get.call_args.kwargs.get("params", {})
        assert "time_range" not in params

    def test_invalid_falls_back_to_all_time(self, client):
        mock_get = AsyncMock(return_value=self._ok_response())
        with patch("httpx.AsyncClient.get", mock_get):
            resp = client.post(
                "/search", json={"query": "test", "max_results": 3, "time_range": "invalid"}
            )
        assert resp.status_code == 200
        params = mock_get.call_args.kwargs.get("params", {})
        assert "time_range" not in params

    def test_default_no_time_range(self, client):
        # time_range を送らない（後方互換: 既存呼び出しは全期間）
        mock_get = AsyncMock(return_value=self._ok_response())
        with patch("httpx.AsyncClient.get", mock_get):
            resp = client.post(
                "/search", json={"query": "test", "max_results": 3}
            )
        assert resp.status_code == 200
        params = mock_get.call_args.kwargs.get("params", {})
        assert "time_range" not in params

    def test_no_engines_param(self, client):
        """engines パラメータは SearXNG 設定に委譲し、送信しない"""
        mock_get = AsyncMock(return_value=self._ok_response())
        with patch("httpx.AsyncClient.get", mock_get):
            resp = client.post("/search", json={"query": "test", "max_results": 3})
        assert resp.status_code == 200
        params = mock_get.call_args.kwargs.get("params", {})
        assert "engines" not in params

class TestSearchTimeRangeRetry:
    """time_range で0件時にフィルタなしで再試行するか検証（httpx をモック）。"""

    def test_empty_with_time_range_retries_without_filter(self, client):
        """time_range ありで0件 → time_range なしで再リクエストする"""
        empty_resp = MagicMock()
        empty_resp.status_code = 200
        empty_resp.json.return_value = {"results": []}

        results_resp = MagicMock()
        results_resp.status_code = 200
        results_resp.json.return_value = {
            "results": [
                {"url": "https://example.com/news", "title": "News", "content": "Breaking news"}
            ]
        }

        mock_get = AsyncMock(side_effect=[empty_resp, results_resp])
        with patch("httpx.AsyncClient.get", mock_get):
            resp = client.post(
                "/search", json={"query": "test", "max_results": 5, "time_range": "year"}
            )

        assert resp.status_code == 200
        assert mock_get.await_count == 2

        # 1回目: time_range=year
        first_params = mock_get.call_args_list[0].kwargs.get("params", {})
        assert first_params.get("time_range") == "year"

        # 2回目: time_range なし
        second_params = mock_get.call_args_list[1].kwargs.get("params", {})
        assert "time_range" not in second_params

        # 再試行の結果が返される
        data = resp.json()
        assert len(data["results"]) == 1
        assert data["results"][0]["url"] == "https://example.com/news"

    def test_empty_without_time_range_no_retry(self, client):
        """time_range なしで0件 → 再試行しない"""
        empty_resp = MagicMock()
        empty_resp.status_code = 200
        empty_resp.json.return_value = {"results": []}

        mock_get = AsyncMock(return_value=empty_resp)
        with patch("httpx.AsyncClient.get", mock_get):
            resp = client.post(
                "/search", json={"query": "test", "max_results": 5}
            )

        assert resp.status_code == 200
        assert mock_get.await_count == 1
        data = resp.json()
        assert data["results"] == []

    def test_results_with_time_range_no_retry(self, client):
        """time_range ありで結果あり → 再試行しない"""
        results_resp = MagicMock()
        results_resp.status_code = 200
        results_resp.json.return_value = {
            "results": [
                {"url": "https://example.com/recent", "title": "Recent", "content": "Recent news"}
            ]
        }

        mock_get = AsyncMock(return_value=results_resp)
        with patch("httpx.AsyncClient.get", mock_get):
            resp = client.post(
                "/search", json={"query": "test", "max_results": 5, "time_range": "week"}
            )

        assert resp.status_code == 200
        assert mock_get.await_count == 1
        data = resp.json()
        assert len(data["results"]) == 1

    def test_retry_failure_returns_empty(self, client):
        """再試行も0件 → 空のまま返す"""
        empty_resp = MagicMock()
        empty_resp.status_code = 200
        empty_resp.json.return_value = {"results": []}

        mock_get = AsyncMock(return_value=empty_resp)
        with patch("httpx.AsyncClient.get", mock_get):
            resp = client.post(
                "/search", json={"query": "test", "max_results": 5, "time_range": "month"}
            )

        assert resp.status_code == 200
        assert mock_get.await_count == 2
        data = resp.json()
        assert data["results"] == []

    def test_retry_exception_returns_empty(self, client):
        """再試行で例外 → 空のまま返す（全体は失敗しない）"""
        empty_resp = MagicMock()
        empty_resp.status_code = 200
        empty_resp.json.return_value = {"results": []}

        # 1回目は0件、2回目（再試行）は例外
        mock_get = AsyncMock(side_effect=[empty_resp, RuntimeError("connection reset")])
        with patch("httpx.AsyncClient.get", mock_get):
            resp = client.post(
                "/search", json={"query": "test", "max_results": 5, "time_range": "day"}
            )

        assert resp.status_code == 200
        assert mock_get.await_count == 2
        data = resp.json()
        assert data["results"] == []



class TestSearchPagination:
    """SearXNG への問い合わせが SEARXNG_SAFE_LIMIT 件ずつページネーションで
    分割されるか検証（httpx をモック）。"""

    @staticmethod
    def _make_results(n: int, prefix: str = "https://example.com/r") -> list[dict]:
        return [
            {"url": f"{prefix}{i}", "title": f"Result {i}", "content": f"content {i}"}
            for i in range(n)
        ]

    def test_max_results_within_safe_limit_single_request(self, client):
        """max_results <= SAFE_LIMIT なら1回のリクエストで完了"""
        results_resp = MagicMock()
        results_resp.status_code = 200
        results_resp.json.return_value = {"results": self._make_results(5)}

        mock_get = AsyncMock(return_value=results_resp)
        with patch("httpx.AsyncClient.get", mock_get), patch(
            "main.scrape_url_safe", AsyncMock(return_value={})
        ):
            resp = client.post(
                "/search", json={"query": "test", "max_results": 3}
            )

        assert resp.status_code == 200
        assert mock_get.await_count == 1
        # pageno=1
        params = mock_get.call_args_list[0].kwargs.get("params", {})
        assert params.get("pageno") == 1

    def test_max_results_exceeds_safe_limit_paginates(self, client):
        """max_results=8, SAFE_LIMIT=5 → 2回リクエスト（pageno=1 で5件, pageno=2 で3件）"""
        page1 = MagicMock()
        page1.status_code = 200
        page1.json.return_value = {"results": self._make_results(5)}

        page2 = MagicMock()
        page2.status_code = 200
        page2.json.return_value = {"results": self._make_results(3, prefix="https://example.com/p2_")}

        mock_get = AsyncMock(side_effect=[page1, page2])
        with patch("httpx.AsyncClient.get", mock_get), patch(
            "main.scrape_url_safe", AsyncMock(return_value={})
        ):
            resp = client.post(
                "/search", json={"query": "test", "max_results": 8}
            )

        assert resp.status_code == 200
        assert mock_get.await_count == 2
        first_params = mock_get.call_args_list[0].kwargs.get("params", {})
        second_params = mock_get.call_args_list[1].kwargs.get("params", {})
        assert first_params.get("pageno") == 1
        assert second_params.get("pageno") == 2
        # 8件すべて返却
        data = resp.json()
        assert len(data["results"]) == 8

    def test_pagination_stops_when_page_returns_empty(self, client):
        """ページが空を返したら追加リクエストを行わない"""
        page1 = MagicMock()
        page1.status_code = 200
        page1.json.return_value = {"results": self._make_results(5)}

        empty_page = MagicMock()
        empty_page.status_code = 200
        empty_page.json.return_value = {"results": []}

        mock_get = AsyncMock(side_effect=[page1, empty_page])
        with patch("httpx.AsyncClient.get", mock_get), patch(
            "main.scrape_url_safe", AsyncMock(return_value={})
        ):
            resp = client.post(
                "/search", json={"query": "test", "max_results": 15}
            )

        assert resp.status_code == 200
        # page1 で5件、page2 が空で停止 → 2回
        assert mock_get.await_count == 2
        data = resp.json()
        assert len(data["results"]) == 5

    def test_pagination_stops_on_non_200(self, client):
        """SearXNG が非200を返したら追加リクエストを行わない"""
        page1 = MagicMock()
        page1.status_code = 200
        page1.json.return_value = {"results": self._make_results(5)}

        error_page = MagicMock()
        error_page.status_code = 503

        mock_get = AsyncMock(side_effect=[page1, error_page])
        with patch("httpx.AsyncClient.get", mock_get), patch(
            "main.scrape_url_safe", AsyncMock(return_value={})
        ):
            resp = client.post(
                "/search", json={"query": "test", "max_results": 15}
            )

        assert resp.status_code == 200
        assert mock_get.await_count == 2
        data = resp.json()
        assert len(data["results"]) == 5


class TestBatchScraping:
    """スクレイピングが SCRAPE_BATCH_SIZE 件同時バッチで実行され、
    バッチ間に wait が入るか検証。"""

    @staticmethod
    def _make_results(n: int) -> list[dict]:
        return [
            {"url": f"https://example.com/page{i}", "title": f"Page {i}", "content": f"c{i}"}
            for i in range(n)
        ]

    def test_batch_count_for_seven_results(self, client):
        """max_results=7, BATCH_SIZE=2 → scrape_url_safe は7回呼ばれる（4バッチ: 2+2+2+1）"""
        searxng_resp = MagicMock()
        searxng_resp.status_code = 200
        searxng_resp.json.return_value = {"results": self._make_results(7)}

        mock_get = AsyncMock(return_value=searxng_resp)
        mock_scrape = AsyncMock(side_effect=lambda url: {"url": url, "title": "t", "content": "x"})

        with patch("httpx.AsyncClient.get", mock_get), patch(
            "main.scrape_url_safe", mock_scrape
        ), patch("main.asyncio.sleep", AsyncMock()) as mock_sleep:
            resp = client.post(
                "/search", json={"query": "test", "max_results": 7}
            )

        assert resp.status_code == 200
        # SearXNG は SAFE_LIMIT=5 なので2ページ（5+2）= 2回 + scrape 間の sleep
        # scrape_url_safe は結果7件全てに対して1回ずつ = 7回
        assert mock_scrape.await_count == 7
        data = resp.json()
        assert len(data["results"]) == 7
        # 全件スクレイピング成功
        assert all(r["scraped"] for r in data["results"])
        # バッチ間 sleep は結果7件 / バッチ2 = 4バッチ → 3回のバッチ間 wait
        # (SearXNG ページネーションの wait も asyncio.sleep なので合計はそれ以上)
        assert mock_sleep.await_count >= 3

    def test_batch_delay_between_scrape_batches(self, client):
        """バッチ間に SCRAPE_BATCH_DELAY が渡されるか検証"""
        searxng_resp = MagicMock()
        searxng_resp.status_code = 200
        searxng_resp.json.return_value = {"results": self._make_results(5)}

        mock_get = AsyncMock(return_value=searxng_resp)
        mock_scrape = AsyncMock(return_value={})

        sleep_delays: list[float] = []

        async def _record_sleep(delay):
            sleep_delays.append(delay)

        with patch("httpx.AsyncClient.get", mock_get), patch(
            "main.scrape_url_safe", mock_scrape
        ), patch("main.asyncio.sleep", AsyncMock(side_effect=_record_sleep)):
            resp = client.post(
                "/search", json={"query": "test", "max_results": 5}
            )

        assert resp.status_code == 200
        # 5件 / バッチ2 = 3バッチ → 2回のバッチ間 wait (SCRAPE_BATCH_DELAY)
        # ページネーションは SAFE_LIMIT=5 なので1ページで完了 → wait なし
        # スクレイプバッチ間の wait だけ SCRAPE_BATCH_DELAY が渡る
        assert SCRAPE_BATCH_DELAY in sleep_delays

    def test_empty_results_no_scrape_calls(self, client):
        """結果0件 → scrape_url_safe は呼ばれない"""
        empty_resp = MagicMock()
        empty_resp.status_code = 200
        empty_resp.json.return_value = {"results": []}

        mock_get = AsyncMock(return_value=empty_resp)
        mock_scrape = AsyncMock(return_value={})

        with patch("httpx.AsyncClient.get", mock_get), patch(
            "main.scrape_url_safe", mock_scrape
        ):
            resp = client.post(
                "/search", json={"query": "test", "max_results": 5}
            )

        assert resp.status_code == 200
        assert mock_scrape.await_count == 0
        data = resp.json()
        assert data["results"] == []