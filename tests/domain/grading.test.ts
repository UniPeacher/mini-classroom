import { describe, expect, it } from 'vitest';
import { gradeMcq } from '../../src/domain/grading';
import type { Mcq } from '../../src/shared/content';

const question: Mcq = {
  type: 'mcq',
  stem: '关于 unknown，哪项正确？',
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
