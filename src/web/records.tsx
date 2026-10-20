import { useState } from 'react';
import { type MapRecord, type Stage, api } from './api';
import { RichMarkdown } from './RichMarkdown';

const ERROR_LABEL = { misconception: '误解', forgetting: '遗忘' } as const;
const RATING_LABEL = { hard: '困难', good: '良好', easy: '轻松' } as const;

export const formatTime = (iso: string) =>
  new Date(iso).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** 已学会、可以重新学习的阶段（理解阶段本来就会被重讲） */
export const isLearned = (stage: Stage) => stage === 'recall' || stage === 'apply' || stage === 'retain';

const RELEARN_CONFIRM = '重新学习会把知识点退回"理解"阶段：下一节微课堂换一种讲法重讲，答对后复习安排从头开始。确定吗？';

/** 重新学习：确认后提交，给出结果提示；成功后调用 onDone 刷新页面数据 */
export function useRelearn(onDone: () => void) {
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  async function relearn(ids: string[]) {
    if (!window.confirm(RELEARN_CONFIRM)) return;
    setNotice('');
    setError('');
    try {
      const { relearned } = await api.relearn(ids);
      setNotice(`已安排：下一节微课堂会重讲 ${relearned.length} 个知识点。`);
      onDone();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return { relearn, notice, error };
}

/** 一次作答的留档：讲解（如有）、题目、你的回答、批改结果、参考答案 */
export function RecordView({ record, label, explanationOpen }: { record: MapRecord; label: string; explanationOpen: boolean }) {
  const { question, answer } = record;
  const verdict = record.correct
    ? `答对${record.selfRating ? ` · 自评${RATING_LABEL[record.selfRating]}` : ''}`
    : `答错 · ${ERROR_LABEL[record.errorType!]}`;

  return (
    <div className="record">
      <div className="record-head">
        {label} · {formatTime(record.at)} · {record.kind === 'lesson' ? '讲解与小题' : '复习题'} ·{' '}
        <strong className={record.correct ? 'ok' : 'bad'}>{verdict}</strong>
      </div>

      {record.explanation && (
        <details open={explanationOpen}>
          <summary>讲解</summary>
          <article className="explanation">
            <RichMarkdown>{record.explanation}</RichMarkdown>
          </article>
        </details>
      )}

      {question.type === 'mcq' ? (
        <>
          <RichMarkdown>{question.stem}</RichMarkdown>
          <ol className="options">
            {question.options.map((option, i) => (
              <li key={i} className={i === question.answerIndex ? 'correct' : 'choice' in answer && answer.choice === i ? 'wrong' : ''}>
                <RichMarkdown>{option.text}</RichMarkdown>
              </li>
            ))}
          </ol>
          <RichMarkdown>{question.explanation}</RichMarkdown>
        </>
      ) : (
        <>
          <RichMarkdown>{question.prompt}</RichMarkdown>
          <p className="muted">你的回答</p>
          <blockquote>{'text' in answer ? answer.text : ''}</blockquote>
          {record.feedback && <RichMarkdown>{record.feedback}</RichMarkdown>}
          <details>
            <summary>参考答案（仅供对照，不是唯一标准）</summary>
            <RichMarkdown>{question.referenceAnswer}</RichMarkdown>
          </details>
        </>
      )}
    </div>
  );
}
