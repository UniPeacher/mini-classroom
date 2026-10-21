CREATE TABLE `ask_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text,
	`knowledge_point_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`knowledge_point_id`) REFERENCES `knowledge_points`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
-- 已有的提问：每一节的提问归为一个会话
INSERT INTO `ask_threads` (`id`, `session_id`, `knowledge_point_id`, `created_at`)
	SELECT 'thread-' || COALESCE(`session_id`, `id`), `session_id`, NULL, MIN(`created_at`) FROM `asks` GROUP BY COALESCE(`session_id`, `id`);
--> statement-breakpoint
-- SQLite 不能给已有表加非空的外键列：重建 asks 表
CREATE TABLE `asks_new` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`session_id` text,
	`knowledge_point_id` text,
	`quote` text,
	`question` text NOT NULL,
	`answer` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `ask_threads`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`knowledge_point_id`) REFERENCES `knowledge_points`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `asks_new` (`id`, `thread_id`, `session_id`, `knowledge_point_id`, `quote`, `question`, `answer`, `created_at`)
	SELECT `id`, 'thread-' || COALESCE(`session_id`, `id`), `session_id`, `knowledge_point_id`, NULL, `question`, `answer`, `created_at` FROM `asks`;
--> statement-breakpoint
DROP TABLE `asks`;
--> statement-breakpoint
ALTER TABLE `asks_new` RENAME TO `asks`;
