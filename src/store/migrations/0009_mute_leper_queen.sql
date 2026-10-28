CREATE TABLE `courses` (
	`id` text PRIMARY KEY NOT NULL,
	`discipline_id` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`discipline_id`) REFERENCES `disciplines`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `disciplines` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`preset_id` text DEFAULT 'default' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `items` ADD `guidance_fingerprint` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `scope_kind` text DEFAULT 'all' NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `scope_id` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `scope_label` text;--> statement-breakpoint
ALTER TABLE `topic_drafts` ADD `course_id` text REFERENCES courses(id);--> statement-breakpoint
ALTER TABLE `topics` ADD `course_id` text REFERENCES courses(id);