ALTER TABLE "threads" ADD COLUMN "response_mode" text DEFAULT 'single' NOT NULL;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "dual_model_a" text;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "dual_model_b" text;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "dual_strategy" text DEFAULT 'cross_review' NOT NULL;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "dual_debate_rounds" integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "metadata" jsonb;
