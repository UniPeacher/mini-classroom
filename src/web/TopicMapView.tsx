import { useEffect, useState } from 'react';
import { type MapPoint, type MapRecord, type TopicMap, api } from './api';
import { RichMarkdown } from './RichMarkdown';

const STAGE_LABEL: Record<MapPoint['stage'], string> = {
  unlearned: '未学',
  understand: '理解',
  recall: '回忆',
  apply: '应用',
  retain: '保持',
};
const ERROR_LABEL = { misconception: '误解', forgetting: '遗忘' } as const;
const RATING_LABEL = { hard: '困难', good: '良好', easy: '轻松' } as const;

const formatTime = (iso: string) =>
  new Date(iso).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** 认知地图中一个学习主题的部分：知识点卡片网格，点开卡片看掌握情况和学过的内容 */
export function TopicMapView({ topicId, onBack }: { topicId: string; onBack: () => void }) {
  const [map, setMap] = useState<TopicMap | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.topicMap(topicId).then(setMap, (e: Error) => setError(e.message));
  }, [topicId]);

  if (error) return <p className="error">{error}</p>;
  if (!map) return <p className="muted">加载中…</p>;

  const learned = map.points.filter((p) => p.stage !== 'unlearned' && p.stage !== 'understand').length;
  const edge = map.points.filter((p) => p.onEdge).length;

  return (
    <section className="card">
      <button className="link" onClick={onBack}>
        ← 返回首页
      </button>
      <h2>{map.topic.title}</h2>
      {map.points.length === 0 ? (
        <p className="muted">知识图谱还没生成好。</p>
      ) : (
        <>
          <p className="muted">
            已学会 {learned} / {map.points.length} 个知识点 · 下一步可学 {edge} 个
          </p>
          <div className="map-grid">
            {map.points.map((point) => (
              <PointCard
                key={point.id}
                point={point}
                open={openId === point.id}
                onToggle={() => setOpenId(openId === point.id ? null : point.id)}
              />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function PointCard({ point, open, onToggle }: { point: MapPoint; open: boolean; onToggle: () => void }) {
  // 未学且前置还没学会的知识点像被迷雾盖住，淡化显示
  const fog = point.stage === 'unlearned' && !point.onEdge;
  const className = ['point', point.onEdge && 'edge', fog && 'fog', open && 'open'].filter(Boolean).join(' ');

  return (
    <div className={className}>
      <button className="point-head" onClick={onToggle} aria-expanded={open}>
        <span className="point-title">{point.title}</span>
        <span className="badge">{point.onEdge ? '下一步可学' : STAGE_LABEL[point.stage]}</span>
      </button>
      {open && (
        <div className="point-body">
          <p>{point.summary}</p>
          {point.nextReviewAt && <p className="muted">下次复习：{formatTime(point.nextReviewAt)} 之后</p>}
          {point.records.length === 0 ? (
            <p className="muted">
              {point.onEdge ? '还没学。下一节微课堂会排入它。' : '还没学。先学会它的前置知识点，才会排入微课堂。'}
            </p>
          ) : (
            point.records.map((record, i) => (
              <RecordView key={record.attemptId} record={record} index={i} latestLesson={isLatestLesson(point.records, i)} />
            ))
          )}
        </div>
      )}
    </div>
  );
}

/** 最近一次讲解默认展开，更早的讲解折叠，免得重讲过的知识点页面太长 */
function isLatestLesson(records: MapRecord[], index: number): boolean {
  return records.findLastIndex((r) => r.kind === 'lesson') === index;
}

/** 一次作答的留档：讲解（如有）、题目、你的回答、批改结果、参考答案 */
function RecordView({ record, index, latestLesson }: { record: MapRecord; index: number; latestLesson: boolean }) {
  const { question, answer } = record;
  const verdict = record.correct
    ? `答对${record.selfRating ? ` · 自评${RATING_LABEL[record.selfRating]}` : ''}`
    : `答错 · ${ERROR_LABEL[record.errorType!]}`;

  return (
    <div className="record">
      <div className="record-head">
        第 {index + 1} 次 · {formatTime(record.at)} · {record.kind === 'lesson' ? '讲解与小题' : '复习题'} ·{' '}
        <strong className={record.correct ? 'ok' : 'bad'}>{verdict}</strong>
      </div>

      {record.explanation && (
        <details open={latestLesson}>
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
