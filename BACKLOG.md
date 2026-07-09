# Backlog (Future Implementation)

Candidates to tackle once Phases 0–8 are broadly complete. PLAN.md holds only in-progress phases; undecided future requirements live here. When starting implementation, refine the requirements first, then promote to a phase in PLAN.md.

## URL Scraping + IP Block Avoidance ✅ → Promoted to Phase 9

- **Purpose**: Fetch web pages, convert them to text, and use as a knowledge source for RAG/search (pairs well with the vector infrastructure from Phase 7).
- **Prerequisite**: Scraping from a single IP sequentially is likely to get blocked, so an avoidance mechanism is essential.

### Pending Decisions (Discuss Before Starting)
- Proxy method selection:
  - Commercial rotating proxies (Bright Data / ScraperAPI, etc.) — stable but paid.
  - Self-hosted proxy pool — free but higher operational overhead.
  - Simple jittered delays + UA rotation only — may suffice for small-scale use.
- Rate limiting approach: jitter between requests, per-domain concurrency limits, exponential backoff on 429/403 detection.
- Caching: content_hash-based cache to avoid re-fetching the same URL (can integrate with Phase 7's embeddings.content_hash).
- Fetch target normalization: respect robots.txt, use sitemaps, depth limits.

### Notes
- The natural approach is to ride on the Phase 7 (Vector RAG + search) pipeline. The `content_hash` in the embeddings table can be reused as the scraping cache key.
- When implementing, settle on the proxy method first (the module structure changes depending on the approach).
