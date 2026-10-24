CREATE TABLE `asks` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text,
	`knowledge_point_id` text,
	`question` text NOT NULL,
	`answer` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`knowledge_point_id`) REFERENCES `knowledge_points`(`id`) ON UPDATE no action ON DELETE no action
);
