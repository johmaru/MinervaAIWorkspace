ALTER TABLE `threads` ADD `council_size` integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE `threads` ADD `council_time_limit` integer DEFAULT 60 NOT NULL;
