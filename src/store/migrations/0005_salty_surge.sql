CREATE TABLE `illustrations` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`prompt` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`image` blob,
	`media_type` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action
);
