ALTER TABLE `users` ADD `translate_primary_lang` text;--> statement-breakpoint
CREATE TABLE `user_traits` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`category` text NOT NULL,
	`content` text NOT NULL,
	`embedding` text NOT NULL,
	`content_hash` text NOT NULL,
	`model` text NOT NULL,
	`confidence` real DEFAULT 0.5 NOT NULL,
	`evidence_count` integer DEFAULT 1 NOT NULL,
	`suppressed_at` integer,
	`source_thread_id` text,
	`source_message_ids` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `user_traits_user_idx` ON `user_traits` (`user_id`);--> statement-breakpoint
CREATE INDEX `user_traits_category_idx` ON `user_traits` (`category`);--> statement-breakpoint
CREATE INDEX `user_traits_suppressed_idx` ON `user_traits` (`suppressed_at`);