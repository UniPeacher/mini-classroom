import type { Stage } from '../api';
import { STAGES, STAGE_LABEL } from '../labels';

/** 掌握阶段阶梯：各阶段知识点数的分段条，未学为底色。图例的色块就是条上的颜色本身 */
export function StageLadder({ stages, label }: { stages: Stage[]; label?: string }) {
  const total = stages.length;
  const counts = STAGES.map((stage) => ({ stage, count: stages.filter((s) => s === stage).length }));
  const description = counts
    .filter((c) => c.count > 0)
    .map((c) => `${STAGE_LABEL[c.stage]} ${c.count}`)
    .join('，');
  return (
    <div className="ladder" role="img" aria-label={`${label ?? '掌握阶段'}：${description || '暂无知识点'}`}>
      {total > 0 &&
        counts
          .filter((c) => c.stage !== 'unlearned' && c.count > 0)
          .map((c) => <span key={c.stage} className={`st-${c.stage}`} style={{ width: `${(c.count / total) * 100}%` }} />)}
    </div>
  );
}

/** 阶梯的图例：可选加上认知边缘和迷雾的标记 */
export function StageLegend({ withMap = false }: { withMap?: boolean }) {
  return (
    <div className="legend">
      {STAGES.map((stage) => (
        <span key={stage}>
          <i className={`st-${stage}`} />
          {STAGE_LABEL[stage]}
        </span>
      ))}
      {withMap && (
        <>
          <span>
            <i className="edge" />
            下一步可学
          </span>
          <span>
            <i className="fog" />
            前置未学会
          </span>
        </>
      )}
    </div>
  );
}
