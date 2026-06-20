CREATE TABLE "memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"folder_id" uuid,
	"kind" text NOT NULL,
	"content" text NOT NULL,
	"source_message_ids" jsonb,
	"embedding" vector(1024) NOT NULL,
	"content_hash" text NOT NULL,
	"model" text NOT NULL,
	"importance" real DEFAULT 0.5 NOT NULL,
	"suppressed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP TABLE "embeddings" CASCADE;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memories_thread_idx" ON "memories" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "memories_folder_idx" ON "memories" USING btree ("folder_id");--> statement-breakpoint
CREATE INDEX "memories_kind_idx" ON "memories" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "memories_suppressed_idx" ON "memories" USING btree ("suppressed_at");--> statement-breakpoint
-- 類似検索用: cosine 距離の HNSW インデックス
CREATE INDEX "memories_embedding_hnsw" ON "memories" USING hnsw ("embedding" vector_cosine_ops);
