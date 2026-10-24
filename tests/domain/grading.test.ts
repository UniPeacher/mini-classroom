import { describe, expect, it } from 'vitest';
import { UNKNOWN_CHOICE, gradeMcq, gradePickLine } from '../../src/domain/grading';
import type { Mcq } from '../../src/shared/content';

const question: Mcq = {
  type: 'mcq',
  stem: '关于 unknown，哪项正确？',
  material: null,
  options: [
    { text: '可以直接调用它的方法', misconception: '把 unknown 当成 any' },
    { text: '使用前需要先收窄类型', misconception: null },
    { text: '和 never 一样不能被赋值', misconception: '混淆 unknown 与 never' },
    { text: '以上都不对', misconception: null },
  ],
  answerIndex: 1,
  explanation: 'unknown 是类型安全的 any，使用前必须收窄。',
};

describe('选择题判分', () => {
  it('选中正确答案判为答对，没有错误类型', () => {
    expect(gradeMcq(question, 1)).toMatchObject({ correct: true, errorType: null });
  });

  it('选中带误解标注的干扰项，判为误解，并在反馈中点出这种误解', () => {
    const grade = gradeMcq(question, 0);
    expect(grade).toMatchObject({ correct: false, errorType: 'misconception' });
    expect(grade.feedback).toContain('把 unknown 当成 any');
  });

  it('选中没有误解标注的错误选项，判为遗忘', () => {
    expect(gradeMcq(question, 3)).toMatchObject({ correct: false, errorType: 'forgetting' });
  });

  it('序号越界视为答错（遗忘），不会抛错', () => {
    expect(gradeMcq(question, 9)).toMatchObject({ correct: false, errorType: 'forgetting' });
  });
});

describe('点选错误行判分', () => {
  const pick = {
    type: 'pick_line' as const,
    prompt: '找出有错的一行',
    language: 'ts',
    lines: ['const a = 1;', 'let b: string = 2;', 'const c = a + 1;', 'console.log(c);'],
    answerIndex: 1,
    explanation: '第 2 行把数字赋给了 string',
  };

  it('选中有错的那一行判为答对', () => {
    expect(gradePickLine(pick, 1)).toMatchObject({ correct: true, errorType: null });
  });

  it('选了没有错的行，说明对规则理解有偏差，判为误解，并指出正确的行', () => {
    const grade = gradePickLine(pick, 3);
    expect(grade).toMatchObject({ correct: false, errorType: 'misconception' });
    expect(grade.feedback).toContain('第 4 行没有问题');
    expect(grade.feedback).toContain('第 2 行');
  });

  it('序号越界（没有选）判为遗忘', () => {
    expect(gradePickLine(pick, -1)).toMatchObject({ correct: false, errorType: 'forgetting' });
  });
});

describe('选"不知道"', () => {
  it('选择题选"不知道"：判为答错、记为遗忘（不算误解），照样给出解析', () => {
    const grade = gradeMcq(question, UNKNOWN_CHOICE);
    expect(grade).toMatchObject({ correct: false, errorType: 'forgetting' });
    expect(grade.feedback).toContain('不知道');
    expect(grade.feedback).toContain(question.explanation);
  });

  it('点选错误行选"不知道"：同样记为遗忘', () => {
    const pick = { type: 'pick_line' as const, prompt: '找错', language: null, lines: ['a', 'b', 'c', 'd'], answerIndex: 2, explanation: '第 3 行错' };
    expect(gradePickLine(pick, UNKNOWN_CHOICE)).toMatchObject({ correct: false, errorType: 'forgetting' });
  });
});
