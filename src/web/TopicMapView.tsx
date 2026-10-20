import { useCallback, useEffect, useState } from 'react';
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

/** 已学会、可以重新学习的阶段（理解阶段本来就会被重讲） */
const isLearned = (point: MapPoint) => point.stage === 'recall' || point.stage === 'apply' || point.stage === 'retain';

const RELEARN_CONFIRM = '重新学习会把知识点退回"理解"阶段：下一节微课堂换一种讲法重讲，答对后复习安排从头开始。确定吗？';

const formatTime = (iso: string) =>
  new Date(iso).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** 认知地图中一个学习主题的部分：知识点卡片网格，点开卡片看掌握情况和学过的内容 */
export function TopicMapView({ topicId, onBack }: { topicId: string; onBack: () => void }) {
  const [map, setMap] = useState<TopicMap | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(() => {
    api.topicMap(topicId).then(setMap, (e: Error) => setError(e.message));
  }, [topicId]);
  useEffect(load, [load]);

  async function relearnPoints(ids: string[]) {
    if (!window.confirm(RELEARN_CONFIRM)) return;
    setNotice('');
    setError('');
    try {
      const { relearned } = await api.relearn(ids);
      setNotice(`已安排：下一节微课堂会重讲 ${relearned.length} 个知识点。`);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (!map) return error ? <p className="error">{error}</p> : <p className="muted">加载中…</p>;

  const learned = map.points.filter(isLearned).length;
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
          {notice && <p className="notice">{notice}</p>}
          {error && <p className="error">{error}</p>}
          <DayReview points={map.points} onRelearn={relearnPoints} />
          <div className="map-grid">
            {map.points.map((point) => (
              <PointCard
                key={point.id}
                point={point}
                open={openId === point.id}
                onToggle={() => setOpenId(openId === point.id ? null : point.id)}
                onRelearn={() => relearnPoints([point.id])}
              />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

/** 本地时区的日期，用于按天分组作答记录 */
const dayOf = (iso: string) => new Date(iso).toLocaleDateString('sv-SE');
const formatDay = (day: string) => new Date(`${day}T00:00:00`).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' });

/** 按天回看：选一天，按当时的顺序重读那天的讲解和题目；读完可把其中已学会的一起安排重讲 */
function DayReview({ points, onRelearn }: { points: MapPoint[]; onRelearn: (ids: string[]) => void }) {
  // 所有作答记录带上所属知识点，按时间排好，再按天分组；最近的日期在前
  const all = points
    .flatMap((point) => point.records.map((record) => ({ point, record })))
    .sort((a, b) => a.record.at.localeCompare(b.record.at));
  const days = new Map<string, typeof all>();
  for (const entry of all) {
    const day = dayOf(entry.record.at);
    days.set(day, [...(days.get(day) ?? []), entry]);
  }
  const sortedDays = [...days.keys()].sort().reverse();
  const [selected, setSelected] = useState(sortedDays[0] ?? '');
  const [reading, setReading] = useState(false);
  if (sortedDays.length === 0) return null;

  const day = days.has(selected) ? selected : sortedDays[0]!;
  const entries = days.get(day)!;
  const dayPoints = [...new Set(entries.map((e) => e.point))];
  const learned = dayPoints.filter(isLearned);

  return (
    <div className="day-review">
      <div className="row">
        <label>
          按天回看：
          <select value={day} onChange={(e) => setSelected(e.target.value)}>
            {sortedDays.map((d) => (
              <option key={d} value={d}>
                {formatDay(d)}（{new Set(days.get(d)!.map((e) => e.point)).size} 个知识点）
              </option>
            ))}
          </select>
        </label>
        <button onClick={() => setReading(!reading)}>{reading ? '收起' : '回看这一天'}</button>
      </div>
      <p className="muted">这一天学过：{dayPoints.map((p) => p.title).join('、')}</p>

      {reading && (
        <>
          {entries.map(({ point, record }) => (
            <RecordView key={record.attemptId} record={record} label={point.title} explanationOpen />
          ))}
          <div className="day-review-end">
            {learned.length > 0 ? (
              <button onClick={() => onRelearn(learned.map((p) => p.id))}>读完还是没把握？重新学习其中已学会的 {learned.length} 个</button>
            ) : (
              <p className="muted">这些知识点都还没学会，下一节微课堂本来就会重讲。</p>
            )}
            <button onClick={() => setReading(false)}>收起</button>
          </div>
        </>
      )}
    </div>
  );
}

function PointCard(props: { point: MapPoint; open: boolean; onToggle: () => void; onRelearn: () => void }) {
  const { point, open, onToggle, onRelearn } = props;
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
          {isLearned(point) && <button onClick={onRelearn}>重新学习</button>}
          {point.stage === 'understand' && <p className="muted">还没学会，下一节微课堂会换一种讲法重讲。</p>}
          {point.records.length === 0 ? (
            <p className="muted">
              {point.onEdge ? '还没学。下一节微课堂会排入它。' : '还没学。先学会它的前置知识点，才会排入微课堂。'}
            </p>
          ) : (
            point.records.map((record, i) => (
              <RecordView
                key={record.attemptId}
                record={record}
                label={`第 ${i + 1} 次`}
                explanationOpen={isLatestLesson(point.records, i)}
              />
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
function RecordView({ record, label, explanationOpen }: { record: MapRecord; label: string; explanationOpen: boolean }) {
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
