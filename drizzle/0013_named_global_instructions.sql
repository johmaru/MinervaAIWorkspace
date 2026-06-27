CREATE TABLE "global_instructions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "active_instruction_id" uuid;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "global_instruction_id" uuid;--> statement-breakpoint
ALTER TABLE "global_instructions" ADD CONSTRAINT "global_instructions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_active_instruction_id_global_instructions_id_fk" FOREIGN KEY ("active_instruction_id") REFERENCES "public"."global_instructions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_global_instruction_id_global_instructions_id_fk" FOREIGN KEY ("global_instruction_id") REFERENCES "public"."global_instructions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- 既存の users.system_instruction データを移行（前回 0012 で追加したカラム）。
-- non-null の各行から1つの global_instructions 行を作成し、active に設定してから旧カラムを削除。
-- ※ 0012 が未適用の環境では列が存在せず DO ブロックは no-op。
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='system_instruction') THEN
    INSERT INTO "global_instructions" ("user_id", "name", "content")
    SELECT u."id", 'Imported', u."system_instruction"
    FROM "users" u
    WHERE u."system_instruction" IS NOT NULL AND u."system_instruction" <> '';
  END IF;
END $$;--> statement-breakpoint
-- 移行した行をユーザーの active に設定
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='system_instruction') THEN
    UPDATE "users" u
    SET "active_instruction_id" = (
      SELECT g."id" FROM "global_instructions" g
      WHERE g."user_id" = u."id" ORDER BY g."created_at" DESC LIMIT 1
    )
    WHERE u."system_instruction" IS NOT NULL AND u."system_instruction" <> '';
  END IF;
END $$;--> statement-breakpoint
-- 旧カラム削除
ALTER TABLE "users" DROP COLUMN IF EXISTS "system_instruction";
