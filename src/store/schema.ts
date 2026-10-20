import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// 时间统一存毫秒时间戳
const timestamp = (name: string) => integer(name, { mode: 'timestamp_ms' });

/** 学习主题 */
export const topics = sqliteTable('topics', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  status: text('status', { enum: ['active', 'paused'] }).notNull().default('active'),
  priority: integer('priority').notNull().default(1),
  graphStatus: text('graph_status', { enum: ['pending', 'ready', 'failed'] }).notNull().default('pending'),
  createdAt: timestamp('created_at').notNull(),
});

/** 知识点：系统中只存一份 */
export const knowledgePoints = sqliteTable('knowledge_points', {
  id: text('id').primaryKey(),
  topicId: text('topic_id').notNull().references(() => topics.id),
  title: text('title').notNull(),
  summary: text('summary').notNull(),
  // AI 给出的推荐顺序，认知顺序相同时用它排先后
  position: integer('position').notNull(),
});

/**
 * 知识图谱中的关系。
 * prerequisite：from 是 to 的前置；composition：from 是 to 的一部分；confusable：二者易混，无方向。
 */
export const relations = sqliteTable('relations', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  fromId: text('from_id').notNull().references(() => knowledgePoints.id),
  toId: text('to_id').notNull().references(() => knowledgePoints.id),
  type: text('type', { enum: ['composition', 'prerequisite', 'confusable'] }).notNull(),
});

/** 记忆状态：按知识点只记一份 */
export const memoryStates = sqliteTable('memory_states', {
  knowledgePointId: text('knowledge_point_id').primaryKey().references(() => knowledgePoints.id),
  stage: text('stage', { enum: ['unlearned', 'understand', 'recall', 'apply', 'retain'] }).notNull(),
  // FSRS 卡片，进入回忆阶段后才有
  card: text('card', { mode: 'json' }),
  lastExplainForm: text('last_explain_form'),
  lastQuestionForm: text('last_question_form'),
  updatedAt: timestamp('updated_at').notNull(),
});

/** 候选池中的一项内容 */
export const items = sqliteTable('items', {
  id: text('id').primaryKey(),
  knowledgePointId: text('knowledge_point_id').notNull().references(() => knowledgePoints.id),
  // lesson：讲解 + 当场小题；review：复习题
  kind: text('kind', { enum: ['lesson', 'review'] }).notNull(),
  // lesson 为讲解形式，review 为题目形式
  form: text('form').notNull(),
  // 题目形式：lesson 是当场小题的形式，review 与 form 相同
  questionForm: text('question_form').notNull(),
  content: text('content', { mode: 'json' }).notNull(),
  estSeconds: integer('est_seconds').notNull(),
  status: text('status', { enum: ['pooled', 'used', 'void'] }).notNull().default('pooled'),
  createdAt: timestamp('created_at').notNull(),
});

/** 一节微课堂 */
export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  startedAt: timestamp('started_at').notNull(),
  finishedAt: timestamp('finished_at'),
  budgetSeconds: integer('budget_seconds').notNull(),
});

/** 一节微课堂包含的内容与顺序 */
export const sessionItems = sqliteTable(
  'session_items',
  {
    sessionId: text('session_id').notNull().references(() => sessions.id),
    itemId: text('item_id').notNull().references(() => items.id),
    position: integer('position').notNull(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.itemId] })],
);

/** 作答记录 */
export const attempts = sqliteTable('attempts', {
  id: text('id').primaryKey(),
  itemId: text('item_id').notNull().references(() => items.id),
  sessionId: text('session_id').notNull().references(() => sessions.id),
  answer: text('answer', { mode: 'json' }).notNull(),
  correct: integer('correct', { mode: 'boolean' }).notNull(),
  errorType: text('error_type', { enum: ['misconception', 'forgetting'] }),
  feedback: text('feedback'),
  selfRating: text('self_rating', { enum: ['hard', 'good', 'easy'] }),
  // 记忆状态是否已按本次作答更新（答对时要等自评后才更新）
  applied: integer('applied', { mode: 'boolean' }).notNull().default(false),
  durationMs: integer('duration_ms'),
  createdAt: timestamp('created_at').notNull(),
});

/** 后台任务：持久保存，服务重启后接着执行 */
export const jobs = sqliteTable('jobs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  type: text('type', { enum: ['generate_graph', 'fill_pool'] }).notNull(),
  payload: text('payload', { mode: 'json' }).notNull(),
  status: text('status', { enum: ['pending', 'running', 'done', 'failed'] }).notNull().default('pending'),
  tries: integer('tries').notNull().default(0),
  lastError: text('last_error'),
  createdAt: timestamp('created_at').notNull(),
  updatedAt: timestamp('updated_at').notNull(),
});
