CREATE TABLE `skill_evolution_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`skill_id` text NOT NULL,
	`base_version` integer NOT NULL,
	`previous_content` text NOT NULL,
	`proposed_content` text NOT NULL,
	`proposed_name` text,
	`proposed_trigger` text,
	`proposed_tags` text,
	`patch_summary` text NOT NULL,
	`reason` text,
	`evidence_event_ids` text DEFAULT '[]' NOT NULL,
	`content_hash` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`applied_version` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`skill_id`) REFERENCES `skills`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `skill_evo_user_skill_status_idx` ON `skill_evolution_proposals` (`user_id`,`skill_id`,`status`);--> statement-breakpoint
ALTER TABLE `skills` ADD `last_evolution_at` integer;
--> statement-breakpoint
CREATE UNIQUE INDEX `skill_evo_one_draft_per_skill` ON `skill_evolution_proposals` (`user_id`, `skill_id`) WHERE `status` = 'draft';