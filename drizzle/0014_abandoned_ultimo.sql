PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`access_token` text NOT NULL,
	`refresh_token` text,
	`scopes` text,
	`expires_at` integer,
	`workspace_name` text,
	`workspace_icon` text,
	`bot_id` text,
	`owner_name` text,
	`owner_email` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_connections`("id", "user_id", "provider", "access_token", "refresh_token", "scopes", "expires_at", "workspace_name", "workspace_icon", "bot_id", "owner_name", "owner_email", "created_at", "updated_at") SELECT "id", "user_id", "provider", "access_token", "refresh_token", NULL, NULL, "workspace_name", "workspace_icon", "bot_id", "owner_name", "owner_email", "created_at", "updated_at" FROM `connections`;--> statement-breakpoint
DROP TABLE `connections`;--> statement-breakpoint
ALTER TABLE `__new_connections` RENAME TO `connections`;--> statement-breakpoint
PRAGMA foreign_keys=ON;