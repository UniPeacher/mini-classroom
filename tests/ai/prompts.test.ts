import { describe, expect, it } from 'vitest';
import type { StructuredModel, StructuredRequest } from '../../src/ai/gateway';
import {
  answerQuestion,
  decomposePoint,
  generateCheatsheet,
  generateGraph,
  generateLesson,
  generateReview,
  gradeConnection,
  gradeOpenAnswer,
  judgeAppeal,
  preparePlacement,
} from '../../src/ai/generators';
import { ILLUSTRATION_GUIDE } from '../../src/ai/illustration-style';
import { teachingContextLabel, teachingContextOf } from '../../src/ai/teaching-context';
import { diagramGuide, lessonFigureGuide } from '../../src/ai/writing-style';
import { DEFAULT_CONTENT_GUIDANCE } from '../../src/shared/content-guidance';
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
    for (const request of requests) expect(request.system).toContain(DEFAULT_CONTENT_GUIDANCE.tutorialGuidance);
  });

  it('选择题正确答案的位置由代码随机决定，并明确告诉模型', async () => {
    const { model, requests } = recorder();
    await generateReview(model, ctx, 'mcq', {}, () => 0.6);
    await generateLesson(model, ctx, { explainForm: 'explain_direct', questionForm: 'mcq' }, { illustrations: false }, () => 0);
    expect(requests[0]!.prompt).toContain('字母 C，answerIndex 为 2');
    expect(requests[1]!.prompt).toContain('字母 A，answerIndex 为 0');
  });

  it('讲解每节要求配 1~2 张图；配置了图像模型才提供插画这种形式', async () => {
    const { model, requests } = recorder();
    await generateLesson(model, ctx, { explainForm: 'explain_direct', questionForm: 'mcq' });
    await generateLesson(model, ctx, { explainForm: 'explain_direct', questionForm: 'mcq' }, { illustrations: true });
    for (const request of requests) expect(request.prompt).toContain('每节讲解配 1~2 张图');
    expect(requests[0]!.prompt).toContain(lessonFigureGuide({ illustrations: false }));
    expect(requests[0]!.prompt).not.toContain(ILLUSTRATION_GUIDE);
    expect(requests[1]!.prompt).toContain(lessonFigureGuide({ illustrations: true }));
    expect(requests[1]!.prompt).toContain(ILLUSTRATION_GUIDE);
  });

  it.each([false, true])('配图先选择教学作用，允许多种形式组合；图像模型启用：%s', async (illustrations) => {
    const { model, requests } = recorder();
    await generateLesson(model, ctx, { explainForm: 'explain_direct', questionForm: 'mcq' }, { illustrations });
    const prompt = requests[0]!.prompt;
    for (const purpose of ['建立第一印象', '形成直观理解', '呈现过程与机制', '突出关系与差异', '综合组织知识']) {
      expect(prompt).toContain(purpose);
    }
    expect(prompt).toContain('一张图可以同时承担多个相互配合的教学作用');
    expect(prompt).toContain('知识类型');
    expect(prompt).toContain('学习者');
    expect(prompt).not.toMatch(/guizang|op7418|材质化|只用一种强调色|一张图只说明一件事|一张图只讲一个机制|不在图里写段落和图例|3~5 个简体中文标签/);
    // 表达自由仍须遵守现有图解的安全和可读性边界。
    expect(prompt).toContain('不写 script，不引用外部资源');
    expect(prompt).toContain('不被裁切');
  });

  it('复习题看图更容易考查理解时可以用代码画的图，不画插画', async () => {
    const { model, requests } = recorder();
    await generateReview(model, ctx, 'short_answer');
    expect(requests[0]!.prompt).toContain(diagramGuide());
    expect(requests[0]!.prompt).not.toContain(ILLUSTRATION_GUIDE);
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
    await generateReview(model, ctx, 'pick_line', {}, () => 0.5);
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

describe('课程教学上下文', () => {
  const language = teachingContextOf('language', { disciplineName: '语言', courseName: '西班牙语' });

  it('图谱、摸底、拆解、提问、速查带上学科要求，但不含整套教程排版规则', async () => {
    const { model, requests } = recorder();
    await generateGraph(model, '西班牙语动词变位', null, language);
    await preparePlacement(model, { topicTitle: '西班牙语动词变位', background: '', points: [{ id: 'p1', title: '甲', summary: '' }], probeIds: [], teaching: language });
    await decomposePoint(model, { ...ctx, existingTitles: [], teaching: language });
    await answerQuestion(model, { ...askCtx, teaching: language }, { question: '为什么这样变位？', history: [] });
    await generateCheatsheet(model, { scopeTitle: '西语', points: [], confusablePairs: [], connections: [], teaching: language });
    expect(requests).toHaveLength(5);
    for (const request of requests) {
      expect(request.prompt).toContain('例句保留目标语言的原文');
      expect(request.prompt).toContain('学科：语言');
      // 排版规则属于教程引导词，不应被塞进这些任务的上下文
      expect(request.prompt).not.toContain('一句话不超过 30 个字');
    }
  });

  it('判分、联结批改与申诉只带学科背景，判定标准与输出结构不变', async () => {
    const { model, requests } = recorder();
    await gradeOpenAnswer(model, ctx, SHORT, '我的作答', teachingContextLabel('stem'));
    await gradeConnection(model, { topicTitle: 'T', title: '甲', summary: '概要', partner: '乙' }, '说说关系', '我的理解', teachingContextLabel('stem'));
    await judgeAppeal(model, ctx, { question: SHORT, answer: '我的作答', originalFeedback: '判错', reason: '我认为对' }, teachingContextLabel('stem'));
    expect(requests).toHaveLength(3);
    for (const request of requests) {
      expect(request.prompt).toContain('批改标准与输出结构不变');
      expect(request.prompt).not.toContain('学科补充要求');
      expect(request.prompt).not.toContain('一句话不超过 30 个字');
    }
    // 判定规则仍在
    expect(requests[0]!.prompt).toContain('判为正确（correct = true）');
    expect(requests[2]!.prompt).toContain('accepted：学习者的答案也成立');
  });

  it('不传教学上下文时提示词与改动前一致（向后兼容）', async () => {
    const { model, requests } = recorder();
    await generateGraph(model, 'TypeScript 常用技能');
    await generateGraph(model, 'TypeScript 常用技能', null, null);
    await preparePlacement(model, { topicTitle: 'T', background: '', points: [], probeIds: [] });
    await gradeOpenAnswer(model, ctx, SHORT, '我的作答');
    for (const request of requests) {
      expect(request.prompt).not.toContain('教学预设');
    }
    expect(requests[0]!.prompt).toBe(requests[1]!.prompt);
  });

  it('default 预设不追加任何学科要求', async () => {
    const { model, requests } = recorder();
    await generateGraph(model, 'TypeScript 常用技能', null, teachingContextOf('default'));
    await decomposePoint(model, { ...ctx, existingTitles: [], teaching: teachingContextOf('default') });
    for (const request of requests) expect(request.prompt).not.toContain('学科补充要求');
  });
});

/** 提问时的上下文：正在学的知识点、讲解原文、未作答的小题 */
const askCtx = {
  topicTitle: '西班牙语动词变位',
  title: '规则动词现在时',
  summary: '能正确变位',
  explanation: '讲解原文',
  questionText: '哪一个是正确变位？',
  answered: false,
};
