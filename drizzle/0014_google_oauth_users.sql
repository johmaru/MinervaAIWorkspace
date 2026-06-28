ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "type" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_verified" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "image" text;--> statement-breakpoint
-- 既存ユーザーの name を nickname から移植（DrizzleAdapter getUser が name を返すため）
UPDATE "users" SET "name" = "nickname" WHERE "name" IS NULL AND "nickname" IS NOT NULL;