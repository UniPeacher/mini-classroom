-- SQLite 新增 NOT NULL 列必须带默认值；随后按已存内容回填小题形式
ALTER TABLE `items` ADD `question_form` text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE `items` SET `question_form` = coalesce(json_extract(`content`, '$.check.type'), json_extract(`content`, '$.question.type'), '');
