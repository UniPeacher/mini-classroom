import { useCallback, useEffect, useState } from 'react';
import { type DayReview, type ReviewDay, api } from './api';
import { RecordView, isLearned, useRelearn } from './records';

/** 回看页的地址：#/review/2026-10-20，只看某个主题时带 ?topic=<id> */
export interface ReviewRoute {
  day: string;
  topicId?: string;
}

export function reviewHash({ day, topicId }: ReviewRoute): string {
  return `#/review/${day}${topicId ? `?topic=${encodeURIComponent(topicId)}` : ''}`;
}

export function parseReviewHash(hash: string): ReviewRoute | null {
  const match = /^#\/review\/(\d{4}-\d{2}-\d{2})(?:\?(.*))?$/.exec(hash);
  if (!match) return null;
  const topicId = new URLSearchParams(match[2] ?? '').get('topic') ?? undefined;
  return { day: match[1]!, topicId };
}

const formatDay = (day: string) =>
  new Date(`${day}T00:00:00`).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' });

/** 选一天，在新标签页打开那天的回看页；不传主题时回看所有主题 */
export function DayPicker({ topicId }: { topicId?: string }) {
  const [days, setDays] = useState<ReviewDay[] | null>(null);
  const [selected, setSelected] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    api.reviewDays(topicId).then((r) => setDays(r.days), (e: Error) => setError(e.message));
  }, [topicId]);

  if (error) return <p className="error">{error}</p>;
  if (!days || days.length === 0) return null;
  const day = selected || days[0]!.day;

  return (
    <div className="row day-picker">
      <label>
        按天回看：
        <select value={day} onChange={(e) => setSelected(e.target.value)}>
          {days.map((d) => (
            <option key={d.day} value={d.day}>
              {formatDay(d.day)}（{d.pointCount} 个知识点）
            </option>
          ))}
        </select>
      </label>
      <button onClick={() => window.open(reviewHash({ day, topicId }), '_blank')}>回看这一天</button>
    </div>
  );
}

/** 回看页：按当时的顺序重读那一天的讲解和题目；读完可把其中已学会的一起安排重新学习 */
export function DayReviewPage({ route }: { route: ReviewRoute }) {
  const [review, setReview] = useState<DayReview | null>(null);
  const [loadError, setLoadError] = useState('');

  const load = useCallback(() => {
    api.dayReview(route.day, route.topicId).then(setReview, (e: Error) => setLoadError(e.message));
  }, [route.day, route.topicId]);
  useEffect(load, [load]);
  const { relearn, notice, error } = useRelearn(load);

  // 标签页标题写明回看哪一天，离开回看页时恢复
  useEffect(() => {
    const original = document.title;
    document.title = `回看 ${formatDay(route.day)} · 微课堂`;
    return () => {
      document.title = original;
    };
  }, [route.day]);

  if (!review) return loadError ? <p className="error">{loadError}</p> : <p className="muted">加载中…</p>;

  const allTopics = review.topic === null;
  const points = [...new Map(review.entries.map((e) => [e.point.id, e.point])).values()];
  const learned = points.filter((p) => isLearned(p.stage));

  return (
    <section className="card">
      <h2>
        {formatDay(review.day)} 回看 · {review.topic?.title ?? '全部主题'}
      </h2>
      {review.entries.length === 0 ? (
        <p className="muted">这一天没有学习记录。</p>
      ) : (
        <>
          <p className="muted">
            这一天学过 {points.length} 个知识点：{points.map((p) => p.title).join('、')}
          </p>
          {review.entries.map(({ topicTitle, point, record }) => (
            <RecordView
              key={record.attemptId}
              record={record}
              label={allTopics ? `${topicTitle} · ${point.title}` : point.title}
              explanationOpen
            />
          ))}
          <div className="day-review-end">
            {notice && <p className="notice">{notice}</p>}
            {error && <p className="error">{error}</p>}
            {learned.length > 0 ? (
              <button onClick={() => relearn(learned.map((p) => p.id))}>
                读完还是没把握？重新学习其中已学会的 {learned.length} 个
              </button>
            ) : (
              <p className="muted">这些知识点都还没学会，下一节微课堂本来就会重讲。</p>
            )}
          </div>
        </>
      )}
    </section>
  );
}
