import { describe, expect, it } from 'vitest';
import type { StructuredModel, StructuredRequest } from '../../src/ai/gateway';
import { generateGraph, generateLesson, generateReview, gradeOpenAnswer, preparePlacement } from '../../src/ai/generators';
import { DIAGRAM_GUIDE, WRITING_PRINCIPLES } from '../../src/ai/writing-style';
import { SHORT } from '../fixtures/fake-model';

/** 只记录请求、不返回内容的模型 */
function recorder() {
  const requests: StructuredRequest<unknown>[] = [];
  const model: StructuredModel = {
    async generate<T>(request: StructuredRequest<T>): Promise<T> {
      requests.push(request as StructuredRequest<unknown>);
      return {} as T;
    },
  };
  return { model, requests };
}

const ctx = { topicTitle: 'TypeScript 常用技能', title: 'unknown 类型', summary: '使用前先收窄', prerequisites: [], confusables: ['any 类型'] };

describe('提示词', () => {
  it('所有写给学习者的内容都带上统一的写作原则', async () => {
    const { model, requests } = recorder();
    await generateGraph(model, ctx.topicTitle);
    await generateLesson(model, ctx, { explainForm: 'explain_direct', questionForm: 'mcq' });
    await generateReview(model, ctx, 'short_answer');
    await gradeOpenAnswer(model, ctx, SHORT, '我的作答');
    expect(requests).toHaveLength(4);
    for (const request of requests) expect(request.system).toContain(WRITING_PRINCIPLES);
  });

  it('选择题正确答案的位置由代码随机决定，并明确告诉模型', async () => {
    const { model, requests } = recorder();
    await generateReview(model, ctx, 'mcq', () => 0.6);
    await generateLesson(model, ctx, { explainForm: 'explain_direct', questionForm: 'mcq' }, () => 0);
    expect(requests[0]!.prompt).toContain('字母 C，answerIndex 为 2');
    expect(requests[1]!.prompt).toContain('字母 A，answerIndex 为 0');
  });

  it('讲解和复习题都要求积极配图', async () => {
    const { model, requests } = recorder();
    await generateLesson(model, ctx, { explainForm: 'explain_direct', questionForm: 'mcq' });
    await generateReview(model, ctx, 'short_answer');
    for (const request of requests) expect(request.prompt).toContain(DIAGRAM_GUIDE);
  });

  it('有补充说明时写进讲解和复习题的提示词，没有时不出现', async () => {
    const { model, requests } = recorder();
    const guidance = '多结合后端开发的真实例子';
    await generateLesson(model, { ...ctx, guidance }, { explainForm: 'explain_direct', questionForm: 'mcq' });
    await generateReview(model, { ...ctx, guidance }, 'short_answer');
    await generateLesson(model, ctx, { explainForm: 'explain_direct', questionForm: 'mcq' });
    for (const request of requests.slice(0, 2)) expect(request.prompt).toContain(`<guidance>\n${guidance}\n</guidance>`);
    expect(requests[2]!.prompt).not.toContain('<guidance>');
  });

  it('点选错误行的错误位置由代码随机决定，并明确告诉模型', async () => {
    const { model, requests } = recorder();
    await generateReview(model, ctx, 'pick_line', () => 0.5);
    expect(requests[0]!.prompt).toContain('有错的是第 3 行（answerIndex 为 2）');
  });

  it('各讲解形式按自己的要求写：分步揭示要 steps，预测揭晓要 predict，对比讲解针对误解', async () => {
    const { model, requests } = recorder();
    await generateLesson(model, ctx, { explainForm: 'explain_steps', questionForm: 'mcq' });
    await generateLesson(model, ctx, { explainForm: 'explain_predict', questionForm: 'mcq' });
    await generateLesson(model, { ...ctx, misconception: '把 unknown 当成 any' }, { explainForm: 'explain_contrast', questionForm: 'mcq' });
    expect(requests[0]!.prompt).toContain('steps 每项是一步');
    expect(requests[1]!.prompt).toContain('predict.scenario');
    expect(requests[2]!.prompt).toContain('学习者最近的误解：把 unknown 当成 any');
    expect(requests[2]!.prompt).toContain('对比讲解');
  });

  it('复习题按掌握阶段考到不同程度：应用阶段取材于真实工作', async () => {
    const { model, requests } = recorder();
    await generateReview(model, { ...ctx, stage: 'apply' }, 'fix');
    expect(requests[0]!.prompt).toContain('类似真实工作的任务');
    expect(requests[0]!.prompt).toContain('修正');
  });

  it('批改补全、修正题时，把模板或有问题的版本交给模型对照', async () => {
    const { model, requests } = recorder();
    const complete = { type: 'complete' as const, prompt: '补全', language: 'ts', template: 'let x: ____', referenceAnswer: 'unknown', keyPoints: ['unknown'] };
    const fix = { type: 'fix' as const, prompt: '修正', language: 'ts', flawed: 'let x: any', referenceAnswer: 'let x: unknown', keyPoints: ['unknown'] };
    await gradeOpenAnswer(model, ctx, complete, 'unknown');
    await gradeOpenAnswer(model, ctx, fix, 'let x: unknown');
    expect(requests[0]!.prompt).toContain('let x: ____');
    expect(requests[1]!.prompt).toContain('let x: any');
  });

  it('摸底题的正确选项位置逐题随机，并写明每题的位置', async () => {
    const { model, requests } = recorder();
    const points = [
      { id: 'p1', title: '甲', summary: '' },
      { id: 'p2', title: '乙', summary: '' },
    ];
    const rolls = [0.1, 0.9];
    await preparePlacement(model, { topicTitle: 'T', background: '', points, probeIds: ['p1', 'p2'] }, () => rolls.shift()!);
    expect(requests[0]!.prompt).toContain('p1：甲（正确选项放在 A，answerIndex 为 0）');
    expect(requests[0]!.prompt).toContain('p2：乙（正确选项放在 D，answerIndex 为 3）');
  });
});
