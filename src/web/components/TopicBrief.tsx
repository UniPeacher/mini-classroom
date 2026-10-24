import type { TopicBrief as Brief } from '../../shared/topic-planning';

/** 在确认页和正式主题页展示同一份学习目标。 */
export function TopicBrief({ brief }: { brief: Brief }) {
  return (
    <dl className="topic-brief-fields">
      <div><dt>学习目的</dt><dd>{brief.goal}</dd></div>
      <div><dt>学习范围</dt><dd><ul>{brief.scope.map((item, index) => <li key={index}>{item}</li>)}</ul></dd></div>
      <div><dt>已有基础</dt><dd>{brief.background || '尚未说明，可以在摸底时补充。'}</dd></div>
    </dl>
  );
}
