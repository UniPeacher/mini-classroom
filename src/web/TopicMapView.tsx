import { useCallback, useEffect, useState } from 'react';
import { type MapPoint, type MapRecord, type TopicMap, api } from './api';
import { DayPicker } from './DayReview';
import { RecordView, formatTime, isLearned, useRelearn } from './records';

const STAGE_LABEL: Record<MapPoint['stage'], string> = {
  unlearned: '未学',
  understand: '理解',
  recall: '回忆',
  apply: '应用',
  retain: '保持',
};
/** 认知地图中一个学习主题的部分：知识点卡片网格，点开卡片看掌握情况和学过的内容 */
export function TopicMapView({ topicId, onBack }: { topicId: string; onBack: () => void }) {
  const [map, setMap] = useState<TopicMap | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState('');

  const load = useCallback(() => {
    api.topicMap(topicId).then(setMap, (e: Error) => setLoadError(e.message));
  }, [topicId]);
  useEffect(load, [load]);
  const { relearn, notice, error } = useRelearn(load);

  if (!map) return loadError ? <p className="error">{loadError}</p> : <p className="muted">加载中…</p>;

  const learned = map.points.filter((p) => isLearned(p.stage)).length;
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
          <DayPicker topicId={topicId} />
          <div className="map-grid">
            {map.points.map((point) => (
              <PointCard
                key={point.id}
                point={point}
                open={openId === point.id}
                onToggle={() => setOpenId(openId === point.id ? null : point.id)}
                onRelearn={() => relearn([point.id])}
              />
            ))}
          </div>
        </>
      )}
    </section>
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
          {isLearned(point.stage) && <button onClick={onRelearn}>重新学习</button>}
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
