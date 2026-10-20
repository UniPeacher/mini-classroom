import { useEffect, useRef, useState } from 'react';
import { type Answer, type Session, type SessionItem, api } from './api';
import { RichMarkdown } from './RichMarkdown';

type Result = NonNullable<SessionItem['attempt']>;

const KIND_LABEL = { new: '新学', advance: '重讲', review: '复习' } as const;
const ERROR_LABEL = { misconception: '误解', forgetting: '遗忘' } as const;

/** 一节微课堂：一次只展示一项，答完再进入下一项 */
export function SessionView(props: { session: Session; notice?: string; onFinish: (correct: number, total: number) => void }) {
  const { session, notice, onFinish } = props;
  const [results, setResults] = useState<Record<string, Result>>(() =>
    Object.fromEntries(session.items.filter((i) => i.attempt).map((i) => [i.id, i.attempt!])),
  );
  // 从第一项还没完成（没作答或待自评）的开始
  const firstOpen = session.items.findIndex((i) => !i.attempt || i.attempt.needsRating);
  const [index, setIndex] = useState(firstOpen === -1 ? session.items.length - 1 : firstOpen);
  const item = session.items[index]!;
  const isLast = index === session.items.length - 1;

  async function next() {
    if (!isLast) return setIndex(index + 1);
    await api.finish(session.id);
    const done = Object.values(results);
    onFinish(done.filter((r) => r.correct).length, session.items.length);
  }

  return (
    <section className="card">
      {notice && index === firstOpen && <p className="notice">{notice}</p>}
      <div className="progress">
        第 {index + 1} / {session.items.length} 项 · <span className="badge">{KIND_LABEL[item.purpose]}</span> {item.title}
      </div>
      <ItemView
        key={item.id}
        sessionId={session.id}
        item={item}
        result={results[item.id] ?? null}
        onResult={(r) => setResults({ ...results, [item.id]: r })}
        onNext={next}
        isLast={isLast}
      />
    </section>
  );
}

function ItemView(props: {
  sessionId: string;
  item: SessionItem;
  result: Result | null;
  onResult: (result: Result) => void;
  onNext: () => void;
  isLast: boolean;
}) {
  const { sessionId, item, result, onResult, onNext, isLast } = props;
  const shownAt = useRef(Date.now());
  const [choice, setChoice] = useState<number | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const question = item.question;

  useEffect(() => {
    shownAt.current = Date.now();
  }, [item.id]);

  async function submit() {
    const answer: Answer = question.type === 'mcq' ? { choice: choice! } : { text };
    setBusy(true);
    setError('');
    try {
      const r = await api.submitAttempt({ sessionId, itemId: item.id, answer, durationMs: Date.now() - shownAt.current });
      onResult({ attemptId: r.attemptId, correct: r.correct, errorType: r.errorType, feedback: r.feedback, needsRating: r.needsRating, reveal: r.reveal });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function rate(selfRating: 'hard' | 'good' | 'easy') {
    await api.rate(result!.attemptId, selfRating);
    onResult({ ...result!, needsRating: false });
    onNext();
  }

  const canSubmit = question.type === 'mcq' ? choice !== null : text.trim().length > 0;

  return (
    <div className="item">
      {item.explanation && (
        <article className="explanation">
          <RichMarkdown>{item.explanation}</RichMarkdown>
        </article>
      )}

      <div className="question">
        {question.type === 'mcq' ? (
          <>
            <RichMarkdown>{question.stem}</RichMarkdown>
            <ol className="options">
              {question.options.map((option, i) => (
                <li key={i} className={optionClass(i, choice, result)}>
                  <label>
                    <input type="radio" name={item.id} disabled={!!result} checked={choice === i} onChange={() => setChoice(i)} />
                    <RichMarkdown>{option}</RichMarkdown>
                  </label>
                </li>
              ))}
            </ol>
          </>
        ) : (
          <>
            <RichMarkdown>{question.prompt}</RichMarkdown>
            <textarea value={text} onChange={(e) => setText(e.target.value)} disabled={!!result} rows={5} placeholder="用自己的话回答" />
          </>
        )}
      </div>

      {!result && (
        <button className="primary" onClick={submit} disabled={!canSubmit || busy}>
          {busy ? (question.type === 'short_answer' ? 'AI 批改中…' : '提交中…') : '提交'}
        </button>
      )}
      {error && <p className="error">{error}</p>}

      {result && (
        <div className={`result ${result.correct ? 'ok' : 'bad'}`}>
          <strong>{result.correct ? '答对了' : `答错了 · ${ERROR_LABEL[result.errorType!]}`}</strong>
          {result.feedback && <RichMarkdown>{result.feedback}</RichMarkdown>}
          {'referenceAnswer' in result.reveal && (
            <details open={!result.correct}>
              <summary>参考答案（仅供对照，不是唯一标准）</summary>
              <RichMarkdown>{result.reveal.referenceAnswer}</RichMarkdown>
            </details>
          )}
          {result.needsRating ? (
            <div className="rating">
              <span>这次回答起来感觉：</span>
              <button onClick={() => rate('hard')}>困难</button>
              <button onClick={() => rate('good')}>良好</button>
              <button onClick={() => rate('easy')}>轻松</button>
            </div>
          ) : (
            <button className="primary" onClick={onNext}>
              {isLast ? '完成本节' : '下一项'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** 作答后标出正确答案和所选的错误答案 */
function optionClass(index: number, choice: number | null, result: Result | null): string {
  if (!result || !('answerIndex' in result.reveal)) return '';
  if (index === result.reveal.answerIndex) return 'correct';
  return index === choice ? 'wrong' : '';
}
