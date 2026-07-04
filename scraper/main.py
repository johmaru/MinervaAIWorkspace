"""Scrapling FastAPI microservice.

Single POST /scrape endpoint. Fetches a URL with Scrapling's AsyncFetcher
(TLS fingerprint impersonation via curl_cffi + stealthy_headers + retries),
extracts title + body text, returns JSON.

Respects robots.txt (User-agent: * block, fail-open on fetch failure).
"""

import asyncio
import ipaddress
import os
import re
import socket
import time
from urllib.parse import urlparse

import httpx
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from scrapling.fetchers import AsyncFetcher

app = FastAPI()

MAX_CONTENT_LENGTH = 50000
FETCH_TIMEOUT = 30  # Scrapling のデフォルト
SCRAPE_FETCH_TIMEOUT = int(os.environ.get("SCRAPE_TIMEOUT", str(FETCH_TIMEOUT)))
SEARXNG_SAFE_LIMIT = int(os.environ.get("SEARXNG_SAFE_LIMIT", "5"))
SCRAPE_BATCH_SIZE = 2
SCRAPE_BATCH_DELAY = 0.5  # seconds between scrape batches

# URL 単位のスクレイプキャッシュ（プロセス内、TTL 300s）。
# /search の1リクエスト内で複数クエリが同じ URL をスクレイピングするのを防ぐ。
_SCRAPE_CACHE: dict[str, tuple[float, dict]] = {}
_SCRAPE_CACHE_TTL = 300.0  # seconds


def is_safe_host(hostname: str) -> bool:
    """SSRF 対策: ホスト名を解決し、プライベート/リンクローカル/ループバック/
    10進数IP表記を弾く。解決失敗時は fail-closed（不許可）。
    """
    try:
        infos = socket.getaddrinfo(hostname, None)
    except socket.gaierror:
        # 解決できない = 存在しないドメイン。スクレイプしても意味がないので拒否。
        return False
    for info in infos:
        ip_str = info[4][0]
        # IPv6 の %zone 除去（例: fe80::1%eth0）
        ip_str = ip_str.split("%", 1)[0]
        try:
            ip = ipaddress.ip_address(ip_str)
        except ValueError:
            continue
        # プライベート / リンクローカル / ループバック / 予約済み / 未割当 は全て拒否
        if (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_reserved
            or ip.is_unspecified
            or ip.is_multicast
        ):
            return False
    return True


class ScrapeRequest(BaseModel):
    url: str


@app.post("/scrape")
async def scrape(req: ScrapeRequest):
    # URL 正規化
    try:
        parsed = urlparse(req.url)
        if parsed.scheme not in ("http", "https"):
            return JSONResponse(status_code=400, content={"error": "invalid url scheme"})
        normalized = parsed._replace(fragment="").geturl()
        # ルート URL 以外の末尾スラッシュを削除
        if normalized.endswith("/") and normalized != f"{parsed.scheme}://{parsed.netloc}/":
            normalized = normalized.rstrip("/")
    except Exception:
        return JSONResponse(status_code=400, content={"error": "invalid url"})

    # SSRF 対策: ホスト名を解決し、内部IPを弾く（10進数IP表記も含む）
    if not is_safe_host(parsed.hostname or ""):
        return JSONResponse(status_code=400, content={"error": "blocked: private or reserved IP"})

    # robots.txt チェック
    if not await is_allowed(normalized):
        return JSONResponse(status_code=403, content={"error": "disallowed by robots.txt"})
    try:
        page = await AsyncFetcher.get(
            normalized,
            stealthy_headers=True,
            impersonate="chrome",
            timeout=SCRAPE_FETCH_TIMEOUT,
            retries=3,
            retry_delay=2,
        )
    except Exception as e:
        return JSONResponse(status_code=502, content={"error": f"fetch failed: {str(e)}", "status": 0})

    if page.status != 200:
        return JSONResponse(
            status_code=502,
            content={"error": f"source returned status {page.status}", "status": page.status},
        )

    title = extract_title(page)
    content = extract_text(page)

    return {
        "url": normalized,
        "title": title,
        "content": content,
        "status": page.status,
    }


class SearchRequest(BaseModel):
    query: str
    max_results: int = 5
    time_range: str | None = None  # "day" | "week" | "month" | "year" | None

ALLOWED_TIME_RANGES = {"day", "week", "month", "year"}


@app.post("/search")
async def search(req: SearchRequest):
    """SearXNG で Web 検索し、上位 URL を並列スクレイピングして返す。

    SearXNG はローカルコンテナ（JSON API）なので httpx で直接叩く。
    スクレイピングは既存の is_safe_host / extract_title / extract_text を再利用。
    robots.txt チェックは省略（検索エンジンが既に公開ページを返している前提）。
    """
    if not req.query.strip():
        return JSONResponse(status_code=400, content={"error": "query is required"})

    searxng_url = os.environ.get("SEARXNG_URL", "http://searxng:8080")
    time_range = req.time_range if req.time_range in ALLOWED_TIME_RANGES else None

    async def _fetch_page(client: httpx.AsyncClient, page_params: dict) -> list[dict]:
        """SearXNG にページネーションで問い合わせ、SAFE_LIMIT 件ずつ取得して
        max_results 件になるまで蓄積する。各ページ間に wait を入れる。"""
        accumulated: list[dict] = []
        remaining = req.max_results
        pageno = 1
        while remaining > 0:
            p = {**page_params, "pageno": pageno}
            resp = await client.get(f"{searxng_url}/search", params=p)
            if resp.status_code != 200:
                break
            try:
                data = resp.json()
            except Exception:
                break
            page_results = data.get("results", [])
            want = min(SEARXNG_SAFE_LIMIT, remaining)
            batch = page_results[:want]
            if not batch:
                break
            accumulated.extend(batch)
            remaining -= len(batch)
            pageno += 1
            # ページが要求件数に満たない = SearXNG の結果が尽きた → 追加リクエストしない
            if len(batch) < want:
                break
            if remaining > 0:
                await asyncio.sleep(SCRAPE_BATCH_DELAY)
        return accumulated[: req.max_results]

    try:
        t_searxng = time.monotonic()
        async with httpx.AsyncClient(timeout=20) as client:
            params = {"q": req.query, "format": "json"}
            if time_range:
                params["time_range"] = time_range

            results = await _fetch_page(client, params)

            # time_range で0件の場合はフィルタなしで再試行（publishedDate 未設定の結果が消えるのを防ぐ）
            if not results and time_range:
                retry_params = {k: v for k, v in params.items() if k != "time_range"}
                try:
                    results = await _fetch_page(client, retry_params)
                except Exception:
                    pass  # 再試行失敗時は空のまま
        print(f"[search-timing] searxng query={req.query} duration={(time.monotonic() - t_searxng) * 1000:.0f}ms results={len(results)}", flush=True)
    except Exception as e:
        print(f"[search-timing] searxng query={req.query} duration={(time.monotonic() - t_searxng) * 1000:.0f}ms results=0 (error)", flush=True)
        return JSONResponse(status_code=502, content={"error": f"search failed: {str(e)}"})

    # スクレイピングを SCRAPE_BATCH_SIZE 件同時バッチで実行（対象サイトへの
    # レート制限/BAN 回避）。バッチ間に SCRAPE_BATCH_DELAY 秒 wait。
    t_scrape = time.monotonic()
    scraped: list[dict] = []
    for i in range(0, len(results), SCRAPE_BATCH_SIZE):
        batch = results[i : i + SCRAPE_BATCH_SIZE]
        batch_results = await asyncio.gather(
            *(scrape_url_safe(r.get("url", "")) for r in batch if r.get("url")),
            return_exceptions=True,
        )
        scrape_iter = iter(batch_results)
        for r in batch:
            url = r.get("url", "")
            entry = {
                "url": url,
                "title": r.get("title", ""),
                "snippet": (r.get("content", "") or "")[:200],
                "scraped": False,
                "content": "",
                "scrape_title": "",
                "raw_content": (r.get("content", "") or "")[:1000],  # SearXNG の content 全文(スクレイピング失敗時のフォールバック)
            }
            if url:
                scraped_r = next(scrape_iter, None)
                if isinstance(scraped_r, dict) and scraped_r.get("content"):
                    entry["scraped"] = True
                    entry["content"] = scraped_r["content"][:5000]
                    entry["scrape_title"] = scraped_r.get("title", "")
            scraped.append(entry)
        if i + SCRAPE_BATCH_SIZE < len(results):
            await asyncio.sleep(SCRAPE_BATCH_DELAY)
    print(f"[search-timing] scrape-all duration={(time.monotonic() - t_scrape) * 1000:.0f}ms batched={len(results)}", flush=True)

    return {"query": req.query, "results": scraped}


async def scrape_url_safe(url: str) -> dict:
    """既存のスクレイプロジックを再利用して URL を取得。失敗時は空 dict。

    SSRF 保護（is_safe_host）を継承。robots.txt は /search 内では省略。
    SCRAPE_PROXY 環境変数で Tor 経由を切り替え可能。
    """
    try:
        parsed = urlparse(url)
        if parsed.scheme not in ("http", "https"):
            return {}
        normalized = parsed._replace(fragment="").geturl()
        if normalized.endswith("/") and normalized != f"{parsed.scheme}://{parsed.netloc}/":
            normalized = normalized.rstrip("/")
    except Exception:
        return {}
    if not is_safe_host(parsed.hostname or ""):
        return {}

    # キャッシュチェック（プロセス内、TTL 300s）
    now = time.monotonic()
    cached = _SCRAPE_CACHE.get(normalized)
    if cached and (now - cached[0]) < _SCRAPE_CACHE_TTL:
        print(f"[search-timing] scrape-url url={normalized} duration=0ms ok=true cached=true", flush=True)
        return cached[1]

    proxy = os.environ.get("SCRAPE_PROXY") or None
    retries = 1 if proxy else 2
    t_fetch = time.monotonic()
    try:
        page = await AsyncFetcher.get(
            normalized,
            stealthy_headers=True,
            impersonate="chrome",
            timeout=SCRAPE_FETCH_TIMEOUT,
            retries=retries,
            retry_delay=1,
            proxy=proxy,
        )
    except Exception:
        print(f"[search-timing] scrape-url url={normalized} duration={(time.monotonic() - t_fetch) * 1000:.0f}ms ok=false", flush=True)
        return {}
    if page.status != 200:
        print(f"[search-timing] scrape-url url={normalized} duration={(time.monotonic() - t_fetch) * 1000:.0f}ms ok=false status={page.status}", flush=True)
        return {}
    print(f"[search-timing] scrape-url url={normalized} duration={(time.monotonic() - t_fetch) * 1000:.0f}ms ok=true", flush=True)

    title = extract_title(page)
    content = extract_text(page)
    if not content:
        return {}
    result = {"url": normalized, "title": title, "content": content}
    _SCRAPE_CACHE[normalized] = (time.monotonic(), result)
    return result


def extract_title(page) -> str:
    """<title> → og:title → 空文字。"""
    try:
        titles = page.css("title")
        if titles:
            text = titles[0].text
            if text:
                return str(text).strip()
    except Exception:
        pass
    try:
        ogs = page.css('meta[property="og:title"]')
        if ogs:
            content = ogs[0].attrib.get("content")
            if content:
                return str(content).strip()
    except Exception:
        pass
    return ""


def extract_text(page) -> str:
    """main → article → body の優先で本文を取得。不要タグを除去して get_all_text()。"""
    for selector in ("main", "article", "body"):
        try:
            containers = page.css(selector)
            if not containers:
                continue
            text = containers[0].get_all_text(
                separator="\n",
                strip=True,
                ignore_tags=("script", "style", "nav", "footer", "header", "aside", "iframe", "noscript"),
            )
            text = str(text)
            # 連続空行を正規化
            text = re.sub(r"\n{3,}", "\n\n", text).strip()
            if text:
                return text[:MAX_CONTENT_LENGTH]
        except Exception:
            continue
    return ""


async def is_allowed(url: str) -> bool:
    """robots.txt を取得して判定。取得失敗 / 404 は許可（fail-open）。"""
    parsed = urlparse(url)
    robots_url = f"{parsed.scheme}://{parsed.netloc}/robots.txt"
    try:
        page = await AsyncFetcher.get(robots_url, stealthy_headers=True, timeout=5, retries=1)
    except Exception:
        return True
    if page.status != 200:
        # 404 含め取得できなければ許可
        return True
    try:
        rules = parse_robots_txt(str(page.body, encoding="utf-8", errors="replace"))
    except Exception:
        return True
    for path in rules["disallow_paths"]:
        if path == "/":
            return False
        if parsed.path.startswith(path):
            return False
    return True


def parse_robots_txt(text: str) -> dict:
    """User-agent: * ブロックの Disallow 行を抽出。Allow / wildcard は未サポート。"""
    disallow_paths: list[str] = []
    in_all_block = False
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.lower().startswith("user-agent:"):
            agent = line.split(":", 1)[1].strip()
            in_all_block = agent == "*"
            continue
        if not in_all_block:
            continue
        if line.lower().startswith("disallow:"):
            path = line.split(":", 1)[1].strip()
            if path:
                disallow_paths.append(path)
    return {"disallow_paths": disallow_paths}


@app.get("/tor-check")
async def tor_check():
    """Tor 接続確認: 直接接続と Tor 経由の出口IPを取得して比較。

    SCRAPE_PROXY 環境変数が設定されていれば Tor 経由、なければ直接接続。
    両方のIPを返し、Tor 経由かどうかを判定する。
    """
    proxy = os.environ.get("SCRAPE_PROXY") or None
    ipify_url = "https://api.ipify.org?format=json"

    # 直接接続のIP
    direct_ip = None
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(ipify_url)
            if resp.status_code == 200:
                direct_ip = resp.json().get("ip")
    except Exception:
        pass

    # Tor 経由のIP（SCRAPE_PROXY が設定されている場合）
    tor_ip = None
    tor_error = None
    if proxy:
        try:
            async with httpx.AsyncClient(timeout=30, proxy=proxy) as client:
                resp = await client.get(ipify_url)
                if resp.status_code == 200:
                    tor_ip = resp.json().get("ip")
        except Exception as e:
            tor_error = str(e)

    connected = tor_ip is not None and tor_ip != direct_ip

    return {
        "directIp": direct_ip,
        "torIp": tor_ip,
        "connected": connected,
        "error": tor_error,
    }


if __name__ == "__main__":

    uvicorn.run(app, host="0.0.0.0", port=8000)
