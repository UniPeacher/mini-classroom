CREATE TABLE `topic_drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`idea` text NOT NULL,
	`messages` text NOT NULL,
	`brief` text,
	`revision` integer DEFAULT 0 NOT NULL,
	`topic_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`topic_id`) REFERENCES `topics`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `topics` ADD `learning_brief` text;