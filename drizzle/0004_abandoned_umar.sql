ALTER TABLE `skills` ADD `kind` text DEFAULT 'workflow' NOT NULL;--> statement-breakpoint
ALTER TABLE `skills` ADD `trigger` text;--> statement-breakpoint
ALTER TABLE `skills` ADD `tags` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `skills` ADD `scope` text DEFAULT 'global' NOT NULL;--> statement-breakpoint
ALTER TABLE `skills` ADD `status` text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE `skills` ADD `version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `skills` ADD `source_thread_id` text REFERENCES threads(id);--> statement-breakpoint
ALTER TABLE `skills` ADD `source_message_ids` text;--> statement-breakpoint
ALTER TABLE `skills` ADD `last_used_at` integer;--> statement-breakpoint
ALTER TABLE `skills` ADD `success_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `skills` ADD `failure_count` integer DEFAULT 0 NOT NULL;