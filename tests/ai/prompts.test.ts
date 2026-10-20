import { describe, expect, it } from 'vitest';
import type { StructuredModel, StructuredRequest } from '../../src/ai/gateway';
import { generateGraph, generateLesson, generateReview, gradeShortAnswer } from '../../src/ai/generators';
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
    await gradeShortAnswer(model, ctx, SHORT, '我的作答');
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
});
