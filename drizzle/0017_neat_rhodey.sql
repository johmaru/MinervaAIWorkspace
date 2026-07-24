CREATE TABLE `kb_chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`knowledge_base_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`text` text NOT NULL,
	`embedding` text NOT NULL,
	`content_hash` text NOT NULL,
	`model` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `kb_documents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`knowledge_base_id`) REFERENCES `knowledge_bases`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `kb_chunks_doc_idx` ON `kb_chunks` (`document_id`);--> statement-breakpoint
CREATE INDEX `kb_chunks_kb_idx` ON `kb_chunks` (`knowledge_base_id`);--> statement-breakpoint
CREATE TABLE `kb_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`knowledge_base_id` text NOT NULL,
	`title` text NOT NULL,
	`source_type` text NOT NULL,
	`source_url` text,
	`content` text NOT NULL,
	`content_hash` text NOT NULL,
	`chunk_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`knowledge_base_id`) REFERENCES `knowledge_bases`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `kb_documents_kb_idx` ON `kb_documents` (`knowledge_base_id`);--> statement-breakpoint
CREATE TABLE `knowledge_bases` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `knowledge_bases_user_idx` ON `knowledge_bases` (`user_id`);--> statement-breakpoint
ALTER TABLE `threads` ADD `active_kb_ids` text NOT NULL DEFAULT '[]';