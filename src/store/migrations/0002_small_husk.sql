CREATE TABLE `app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `cheatsheets` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`scope` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`markdown` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `connections` (
	`id` text PRIMARY KEY NOT NULL,
	`from_point_id` text NOT NULL,
	`to_point_id` text,
	`to_existing_id` text,
	`quote` text NOT NULL,
	`relation` text NOT NULL,
	`attempt_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`from_point_id`) REFERENCES `knowledge_points`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`to_point_id`) REFERENCES `knowledge_points`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`to_existing_id`) REFERENCES `existing_knowledge`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`attempt_id`) REFERENCES `attempts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `existing_knowledge` (
	`id` text PRIMARY KEY NOT NULL,
	`topic_id` text,
	`text` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `placements` (
	`topic_id` text PRIMARY KEY NOT NULL,
	`background` text NOT NULL,
	`start_ids` text NOT NULL,
	`probes` text NOT NULL,
	`answers` text NOT NULL,
	`created_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`topic_id`) REFERENCES `topics`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `attempts` ADD `state_before` text;--> statement-breakpoint
ALTER TABLE `attempts` ADD `appeal` text;--> statement-breakpoint
ALTER TABLE `attempts` ADD `voided` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `knowledge_points` ADD `origin` text DEFAULT 'graph' NOT NULL;--> statement-breakpoint
ALTER TABLE `memory_states` ADD `fail_streak` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `memory_states` ADD `pending_contrast` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `memory_states` ADD `last_misconception` text;--> statement-breakpoint
ALTER TABLE `memory_states` ADD `decomposed_at` integer;--> statement-breakpoint
ALTER TABLE `session_items` ADD `purpose` text DEFAULT 'new' NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `new_topic_id` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `device` text DEFAULT 'desktop' NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `guidance` text;--> statement-breakpoint
ALTER TABLE `topics` ADD `placement_status` text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
UPDATE `topics` SET `placement_status` = 'skipped';--> statement-breakpoint
UPDATE `session_items` SET `purpose` = 'review' WHERE `item_id` IN (SELECT `id` FROM `items` WHERE `kind` = 'review');--> statement-breakpoint
UPDATE `session_items` SET `purpose` = 'advance' WHERE `purpose` = 'new' AND EXISTS (
	SELECT 1 FROM `attempts` `a`
	JOIN `items` `i` ON `a`.`item_id` = `i`.`id`
	JOIN `items` `cur` ON `cur`.`id` = `session_items`.`item_id`
	WHERE `i`.`knowledge_point_id` = `cur`.`knowledge_point_id`
		AND `a`.`session_id` <> `session_items`.`session_id`
		AND `a`.`created_at` < (SELECT `started_at` FROM `sessions` WHERE `id` = `session_items`.`session_id`)
);
