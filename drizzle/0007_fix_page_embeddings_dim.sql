-- page_embeddings.embedding を vector(1536) から vector(1024) に修正。
-- migration 0003 で vector(1536) として作成されたが、memories (0005) は vector(1024)。
-- この不整合により検索クエリが "different vector dimensions" エラーになる。
-- 既存データは次元が異なるため変換不可、全削除する。
DROP INDEX IF EXISTS "page_embeddings_embedding_hnsw";--> statement-breakpoint
DELETE FROM "page_embeddings";--> statement-breakpoint
ALTER TABLE "page_embeddings" DROP COLUMN "embedding";--> statement-breakpoint
ALTER TABLE "page_embeddings" ADD COLUMN "embedding" vector(1024) NOT NULL;--> statement-breakpoint
CREATE INDEX "page_embeddings_embedding_hnsw" ON "page_embeddings" USING hnsw ("embedding" vector_cosine_ops);
