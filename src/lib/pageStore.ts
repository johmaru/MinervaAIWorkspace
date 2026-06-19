import { db } from "@/db";
import { pages, pageEmbeddings } from "@/db/schema";
import { eq } from "drizzle-orm";
import { hashContent, embedText } from "@/lib/embed";

/**
 * pages + page_embeddings の upsert を1関数にまとめた知識化ヘルパ。
 *
 * - urlHash で既存ページを検索
 * - contentHash が一致 → キャッシュヒット（再 embed 不要）、既存 id を返す
 * - contentHash が不一致 → pages を upsert し page_embeddings を再生成
 * - 新規 URL → pages を insert し page_embeddings を生成
 *
 * 戻り値: page id。
 *
 * /api/scrape（手動取り込み）と /api/chat（Web 検索で得たURLの自動取り込み）
 * の両方から呼ばれる共通ロジック。
 */
export async function upsertPage(url: string, title: string, content: string): Promise<string> {
  const urlHash = hashContent(url);
  const contentHash = hashContent(content);

  const [existing] = await db.select().from(pages).where(eq(pages.urlHash, urlHash));

  // contentHash が同じ → キャッシュヒット、再 embed 不要
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

  // embed + page_embeddings 保存（既存を削除してから挿入）
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
