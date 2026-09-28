CREATE INDEX `skills_user_status_idx` ON `skills` (`user_id`,`status`);--> statement-breakpoint
CREATE INDEX `threads_user_idx` ON `threads` (`user_id`);