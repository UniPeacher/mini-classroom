import type { SessionItem } from '../api';
import { OPTION_LETTERS } from '../labels';
import { RichMarkdown } from '../RichMarkdown';

/** 作答前看到的题目（不含答案） */
export type HiddenQuestion = NonNullable<SessionItem['question']>;

/** 作答状态：选择类题目记序号，开放题记文字 */
export type Draft = { choice: number | null; text: string };

/** 作答后的标记：正确答案所在位置、自己选的位置 */
export interface Marks {
  answerIndex: number | null;
  chosen: number | null;
}

/** 题干：开放题、点选错误行的说明，或选择题的题干 */
export function QuestionStem({ question }: { question: HiddenQuestion }) {
  return (
    <div className="question-stem reading">
      <RichMarkdown>{question.type === 'mcq' ? question.stem : question.prompt}</RichMarkdown>
    </div>
  );
}

/**
 * 作答区：选择题的选项、点选错误行的代码行、补全的模板、修正的原代码与输入框。
 * marks 不为空时进入只读，标出正确答案与所选的错误答案。
 */
export function AnswerArea(props: { question: HiddenQuestion; draft: Draft; onChange: (draft: Draft) => void; marks: Marks | null; disabled: boolean }) {
  const { question, draft, onChange, marks, disabled } = props;
  const markOf = (i: number) => {
    if (!marks || marks.answerIndex === null) return '';
    if (i === marks.answerIndex) return 'correct';
    return i === marks.chosen ? 'wrong' : '';
  };

  if (question.type === 'mcq') {
    return (
      <div className="options" role="group" aria-label="选项">
        {question.options.map((option, i) => (
          <button
            key={i}
            type="button"
            className={`option ${markOf(i)}`}
            aria-pressed={draft.choice === i}
            disabled={disabled}
            onClick={() => onChange({ ...draft, choice: i })}
          >
            <span className="letter">{OPTION_LETTERS[i]}</span>
            <span className="option-text">
              <RichMarkdown>{option}</RichMarkdown>
            </span>
          </button>
        ))}
      </div>
    );
  }

  if (question.type === 'pick_line') {
    return (
      <div className="code-lines" role="group" aria-label="点选有错的一行">
        {question.lines.map((line, i) => (
          <button
            key={i}
            type="button"
            className={`code-line ${markOf(i)}`}
            aria-pressed={draft.choice === i}
            aria-label={`第 ${i + 1} 行`}
            disabled={disabled}
            onClick={() => onChange({ ...draft, choice: i })}
          >
            <span className="ln">{i + 1}</span>
            <code>{line || ' '}</code>
          </button>
        ))}
      </div>
    );
  }

  const placeholder = {
    short_answer: '用自己的话回答，一两句话就够',
    complete: '写出 ____ 处缺少的部分',
    fix: '直接在这里改成正确的版本',
  }[question.type];

  return (
    <div className="stack">
      {question.type === 'complete' && <pre className="code-block">{question.template}</pre>}
      {question.type === 'fix' && <p className="muted small">有问题的版本已经填在下面，直接修改它。</p>}
      <textarea
        className={`textarea ${question.type === 'short_answer' ? '' : 'code'}`}
        rows={question.type === 'fix' ? Math.min(14, question.flawed.split('\n').length + 2) : 4}
        value={draft.text}
        disabled={disabled}
        placeholder={placeholder}
        aria-label="作答"
        onChange={(e) => onChange({ ...draft, text: e.target.value })}
      />
    </div>
  );
}

/** 题目的初始作答：修正题预先填入有问题的版本 */
export function initialDraft(question: HiddenQuestion | null): Draft {
  return { choice: null, text: question?.type === 'fix' ? question.flawed : '' };
}

export function canSubmit(question: HiddenQuestion, draft: Draft): boolean {
  if (question.type === 'mcq' || question.type === 'pick_line') return draft.choice !== null;
  if (question.type === 'fix') return draft.text.trim().length > 0 && draft.text !== question.flawed;
  return draft.text.trim().length > 0;
}
