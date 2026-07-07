CREATE TABLE `skill_usage_events` (
	`id` text PRIMARY KEY NOT NULL,
	`skill_id` text NOT NULL,
	`user_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`message_id` text,
	`similarity` real,
	`activation_type` text NOT NULL,
	`outcome` text DEFAULT 'unknown' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`skill_id`) REFERENCES `skills`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
