CREATE TABLE "eval_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"selector" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eval_regressions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"eval_id" uuid NOT NULL,
	"metric" text NOT NULL,
	"variant" text NOT NULL,
	"baseline_variant" text NOT NULL,
	"baseline_value" double precision NOT NULL,
	"current_value" double precision NOT NULL,
	"delta" double precision NOT NULL,
	"threshold" double precision NOT NULL,
	"sample_count" integer NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"notified" boolean DEFAULT false NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eval_state" (
	"eval_id" uuid PRIMARY KEY NOT NULL,
	"watermark" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "eval_regressions" ADD CONSTRAINT "eval_regressions_eval_id_eval_definitions_id_fk" FOREIGN KEY ("eval_id") REFERENCES "public"."eval_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_state" ADD CONSTRAINT "eval_state_eval_id_eval_definitions_id_fk" FOREIGN KEY ("eval_id") REFERENCES "public"."eval_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "eval_definitions_name_idx" ON "eval_definitions" USING btree ("name");--> statement-breakpoint
CREATE INDEX "eval_regressions_eval_id_idx" ON "eval_regressions" USING btree ("eval_id","detected_at");