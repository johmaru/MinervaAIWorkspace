CREATE TABLE `memory_injections` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`memory_id` text NOT NULL,
	`injected_at` integer NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`memory_id`) REFERENCES `memories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `memory_injections_message_idx` ON `memory_injections` (`message_id`);--> statement-breakpoint
CREATE INDEX `memory_injections_memory_idx` ON `memory_injections` (`memory_id`);--> statement-breakpoint
ALTER TABLE `memories` ADD `valid_from` integer NOT NULL DEFAULT 0;--> statement-breakpoint
UPDATE `memories` SET `valid_from` = `created_at` WHERE `valid_from` = 0;--> statement-breakpoint
ALTER TABLE `memories` ADD `valid_until` integer;--> statement-breakpoint
ALTER TABLE `memories` ADD `expires_at` integer;--> statement-breakpoint
ALTER TABLE `memories` ADD `injection_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `memories` ADD `last_injected_at` integer;--> statement-breakpoint
ALTER TABLE `memories` ADD `last_referenced_at` integer;--> statement-breakpoint
CREATE INDEX `memories_expires_idx` ON `memories` (`expires_at`);