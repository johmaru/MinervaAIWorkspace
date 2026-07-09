import { db } from "@/db";
import { pages, pageEmbeddings } from "@/db/schema";
import { eq } from "drizzle-orm";
import { hashContent, embedText } from "@/lib/embed";

/**
 * Knowledge ingestion helper that consolidates pages + page_embeddings upsert into one function.
 *
 * - Search for an existing page by urlHash
 * - contentHash matches → cache hit (no re-embed needed), return existing id
 * - contentHash differs → upsert pages and regenerate page_embeddings
 * - New URL → insert into pages and generate page_embeddings
 *
 * Returns: page id.
 *
 * Common logic called from both /api/scrape (manual ingestion) and /api/chat
 * (auto-ingestion of URLs found via web search).
 */
export async function upsertPage(url: string, title: string, content: string): Promise<string> {
  const urlHash = hashContent(url);
  const contentHash = hashContent(content);

  const [existing] = await db.select().from(pages).where(eq(pages.urlHash, urlHash));

  // contentHash matches → cache hit, no re-embed needed
  if (existing && existing.contentHash === contentHash) {
    return existing.id;
  }

  let pageRow: { id: string };
  if (existing) {
    const [updated] = await db
      .update(pages)
      .set({
        url,
        title: title || null,
        content,
        contentHash,
        fetchedAt: new Date(),
        status: 200,
        errorMessage: null,
      })
      .where(eq(pages.id, existing.id))
      .returning();
    pageRow = { id: updated.id };
  } else {
    const [inserted] = await db
      .insert(pages)
      .values({
        url,
        urlHash,
        title: title || null,
        content,
        contentHash,
        status: 200,
      })
      .returning();
    pageRow = { id: inserted.id };
  }

  // embed + save page_embeddings (delete existing then insert)
  const vector = await embedText(content, "document");
  if (vector.length > 0) {
    await db.delete(pageEmbeddings).where(eq(pageEmbeddings.pageId, pageRow.id));
    await db.insert(pageEmbeddings).values({
      pageId: pageRow.id,
      contentHash,
      embedding: vector,
      model: process.env.EMBED_MODEL || "Xenova/all-MiniLM-L6-v2",
    });
  }
  return pageRow.id;
}
