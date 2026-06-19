CREATE TABLE "folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text DEFAULT 'New folder' NOT NULL,
	"instruction" text,
	"memory_scope" text DEFAULT 'global' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "page_embeddings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"page_id" uuid NOT NULL,
	"content_hash" text NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"url" text NOT NULL,
	"url_hash" text NOT NULL,
	"title" text,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" integer DEFAULT 200 NOT NULL,
	"error_message" text,
	CONSTRAINT "pages_url_unique" UNIQUE("url"),
	CONSTRAINT "pages_url_hash_unique" UNIQUE("url_hash")
);
--> statement-breakpoint
ALTER TABLE "attachments" ALTER COLUMN "message_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "thread_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "folder_id" uuid;--> statement-breakpoint
ALTER TABLE "page_embeddings" ADD CONSTRAINT "page_embeddings_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "page_embeddings_page_idx" ON "page_embeddings" USING btree ("page_id");--> statement-breakpoint
CREATE INDEX "pages_url_hash_idx" ON "pages" USING btree ("url_hash");--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachments_thread_idx" ON "attachments" USING btree ("thread_id");