import type { LearningRecord } from '../api';
import { ERROR_LABEL, RATING_LABEL, formatTime } from '../labels';
import { RichMarkdown } from '../RichMarkdown';
import { AnswerArea, type HiddenQuestion, QuestionStem } from './Questions';

type FullQuestion = NonNullable<LearningRecord['question']>;

/** 完整题目去掉答案，按作答前的样子显示 */
function toHidden(question: FullQuestion): HiddenQuestion {
  switch (question.type) {
    case 'mcq':
      return { type: 'mcq', stem: question.stem, options: question.options.map((o) => o.text) };
    case 'short_answer':
      return { type: 'short_answer', prompt: question.prompt };
    case 'pick_line':
      return { type: 'pick_line', prompt: question.prompt, language: question.language, lines: question.lines };
    case 'complete':
      return { type: 'complete', prompt: question.prompt, language: question.language, template: question.template };
    case 'fix':
      return { type: 'fix', prompt: question.prompt, language: question.language, flawed: question.flawed };
  }
}

function verdictOf(record: LearningRecord): { text: string; tone: 'pos' | 'neg' | '' } {
  if (record.voided) return { text: '已作废', tone: '' };
  if (record.kind === 'connection') return record.correct ? { text: '联结成立', tone: 'pos' } : { text: '联结不成立', tone: 'neg' };
  if (record.correct) return { text: record.selfRating ? `答对 · 自评${RATING_LABEL[record.selfRating]}` : '答对', tone: 'pos' };
  return { text: `答错 · ${record.errorType ? ERROR_LABEL[record.errorType] : ''}`, tone: 'neg' };
}

/** 一次作答的完整留档：讲解（可折叠）、题目与正确答案、自己的作答、批改、申诉结果 */
export function RecordView({ record, label, explanationOpen }: { record: LearningRecord; label: string; explanationOpen: boolean }) {
  const verdict = verdictOf(record);
  const answer = record.answer;
  const question = record.question;
  const chosen = 'choice' in answer ? answer.choice : null;
  const answerIndex = question && (question.type === 'mcq' || question.type === 'pick_line') ? question.answerIndex : null;

  return (
    <article className="record">
      <div className="record-head">
        <strong>{label}</strong>
        <span>{formatTime(record.at)}</span>
        <span>{record.formLabel}</span>
        <span className={`pill ${verdict.tone}`}>{verdict.text}</span>
      </div>

      {record.explanation && (
        <details open={explanationOpen}>
          <summary className="card-link">讲解</summary>
          <div className="reading lesson-block" style={{ marginTop: 12 }}>
            <RichMarkdown>{record.explanation}</RichMarkdown>
            {record.steps?.map((step, i) => (
              <div className="step" key={i}>
                <div className="step-count">第 {i + 1} 步</div>
                <RichMarkdown>{step}</RichMarkdown>
              </div>
            ))}
          </div>
        </details>
      )}

      {record.connection && (
        <div className="reading">
          <p>{record.connection.prompt}</p>
          <blockquote>{'text' in answer ? answer.text : ''}</blockquote>
        </div>
      )}

      {question && (
        <div className="question">
          <QuestionStem question={toHidden(question)} />
          {'text' in answer && question.type !== 'mcq' && question.type !== 'pick_line' ? (
            <>
              {question.type === 'complete' && <pre className="code-block">{question.template}</pre>}
              {question.type === 'fix' && (
                <>
                  <p className="muted small" style={{ margin: '0 0 4px' }}>
                    原来有问题的版本
                  </p>
                  <pre className="code-block" style={{ whiteSpace: 'pre-wrap' }}>
                    {question.flawed}
                  </pre>
                </>
              )}
              <p className="muted small" style={{ margin: '10px 0 4px' }}>
                我的作答
              </p>
              <pre className="code-block" style={{ whiteSpace: 'pre-wrap' }}>
                {answer.text}
              </pre>
            </>
          ) : (
            <AnswerArea question={toHidden(question)} draft={{ choice: chosen, text: '' }} onChange={() => undefined} marks={{ answerIndex, chosen }} disabled />
          )}
        </div>
      )}

      {(record.feedback || question) && (
        <div className="result">
          {record.feedback && <RichMarkdown>{record.feedback}</RichMarkdown>}
          {question && 'referenceAnswer' in question && (
            <details>
              <summary>参考答案（只作对照，不是唯一标准）</summary>
              <div className="reading" style={{ marginTop: 8 }}>
                <pre className="code-block" style={{ whiteSpace: 'pre-wrap' }}>
                  {question.referenceAnswer}
                </pre>
                <ul>
                  {question.keyPoints.map((p, i) => (
                    <li key={i}>{p}</li>
                  ))}
                </ul>
              </div>
            </details>
          )}
          {record.appeal && (
            <p style={{ marginTop: 10 }}>
              <span className="pill">{{ accepted: '申诉成立，改判答对', void: '申诉成立，题目作废', rejected: '申诉未成立' }[record.appeal.outcome]}</span>{' '}
              <span className="muted">{record.appeal.feedback}</span>
            </p>
          )}
        </div>
      )}
    </article>
  );
}
