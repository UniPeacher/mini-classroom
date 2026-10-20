CREATE TABLE `attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`session_id` text NOT NULL,
	`answer` text NOT NULL,
	`correct` integer NOT NULL,
	`error_type` text,
	`feedback` text,
	`self_rating` text,
	`applied` integer DEFAULT false NOT NULL,
	`duration_ms` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `items` (
	`id` text PRIMARY KEY NOT NULL,
	`knowledge_point_id` text NOT NULL,
	`kind` text NOT NULL,
	`form` text NOT NULL,
	`content` text NOT NULL,
	`est_seconds` integer NOT NULL,
	`status` text DEFAULT 'pooled' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`knowledge_point_id`) REFERENCES `knowledge_points`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`tries` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `knowledge_points` (
	`id` text PRIMARY KEY NOT NULL,
	`topic_id` text NOT NULL,
	`title` text NOT NULL,
	`summary` text NOT NULL,
	`position` integer NOT NULL,
	FOREIGN KEY (`topic_id`) REFERENCES `topics`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `memory_states` (
	`knowledge_point_id` text PRIMARY KEY NOT NULL,
	`stage` text NOT NULL,
	`card` text,
	`last_explain_form` text,
	`last_question_form` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`knowledge_point_id`) REFERENCES `knowledge_points`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `relations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`from_id` text NOT NULL,
	`to_id` text NOT NULL,
	`type` text NOT NULL,
	FOREIGN KEY (`from_id`) REFERENCES `knowledge_points`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`to_id`) REFERENCES `knowledge_points`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `session_items` (
	`session_id` text NOT NULL,
	`item_id` text NOT NULL,
	`position` integer NOT NULL,
	PRIMARY KEY(`session_id`, `item_id`),
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`budget_seconds` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `topics` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`priority` integer DEFAULT 1 NOT NULL,
	`graph_status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL
);
