/**
 * 真机冒烟：用 .env 中配置的真实模型跑一遍图谱、讲解、复习题和简答批改，供人工检查内容质量。
 * 用法：pnpm exec tsx scripts/smoke-ai.ts [学习主题]
 */
import { existsSync } from 'node:fs';
import { aiSettingsFromEnv } from '../src/ai-settings';
import { modelFromConfig } from '../src/ai/gateway';
import { generateGraph, generateLesson, generateReview, gradeOpenAnswer } from '../src/ai/generators';

if (existsSync('.env')) process.loadEnvFile('.env');

const topicTitle = process.argv[2] ?? 'TypeScript 常用技能';
const model = modelFromConfig(aiSettingsFromEnv(process.env).text);
const timed = async <T>(label: string, run: () => Promise<T>): Promise<T> => {
  const start = Date.now();
  const result = await run();
  console.log(`\n===== ${label}（${((Date.now() - start) / 1000).toFixed(1)}s）=====`);
  return result;
};

const graph = await timed('骨架知识图谱', () => generateGraph(model, topicTitle));
graph.knowledgePoints.forEach((k, i) => console.log(`${i + 1}. ${k.title} —— ${k.summary}`));
console.log('关系：');
graph.relations.forEach((r) => console.log(`  ${r.from} -[${r.type}]-> ${r.to}`));

const first = graph.knowledgePoints[0]!;
const titleOf = (key: string) => graph.knowledgePoints.find((k) => k.key === key)?.title ?? key;
const ctx = {
  topicTitle,
  title: first.title,
  summary: first.summary,
  prerequisites: [],
  confusables: graph.relations
    .filter((r) => r.type === 'confusable' && (r.from === first.key || r.to === first.key))
    .map((r) => titleOf(r.from === first.key ? r.to : r.from)),
};

const lesson = await timed(`讲解（类比）+ 选择题：${first.title}`, () =>
  generateLesson(model, ctx, { explainForm: 'explain_analogy', questionForm: 'mcq' }),
);
console.log(lesson.explanation);
console.log(JSON.stringify(lesson.check, null, 2), `\n预估 ${lesson.estSeconds}s`);

const review = await timed(`复习题（简答）：${first.title}`, () => generateReview(model, ctx, 'short_answer'));
console.log(JSON.stringify(review.question, null, 2));

if (review.question.type === 'short_answer') {
  const question = review.question;
  const wrong = await timed('批改：一个错误作答', () => gradeOpenAnswer(model, ctx, question, '不太记得了，好像和 any 一样？'));
  console.log(JSON.stringify(wrong, null, 2));
  const right = await timed('批改：参考答案本身', () => gradeOpenAnswer(model, ctx, question, question.referenceAnswer));
  console.log(JSON.stringify(right, null, 2));
}
