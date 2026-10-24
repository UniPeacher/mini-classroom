import { DEFAULT_CONTENT_GUIDANCE } from '../shared/content-guidance';
import { ILLUSTRATION_GUIDE } from './illustration-style';

/** 代码画的图：Mermaid 和 SVG 两种画法的写法要求。讲解和题目共用 */
const CODE_DIAGRAM_RULES = `SVG（\`\`\`svg 代码块）
   - 适合需要精确控制位置、连接、文字、代码或数学符号的图解，也可以组合多种表达形式。
   - 完整的 <svg> 元素，带 xmlns 和 viewBox，宽度不超过 640；不写 script，不引用外部资源。
   - 构图、颜色和图例根据表达需要安排，同一含义保持相同的视觉标记；颜色之外配合文字或形状区分内容。
   - 标注紧邻对应对象，避免压在线条和图形上；必要的条件、公式和说明完整保留。文字不小于 14px，用 sans-serif 字体。
   - 四周留足边距，所有图形和文字完整显示，不被裁切。
   - 表现变化过程时可以加动画（CSS @keyframes 或 SMIL）：节奏便于跟随，突出当前变化的部分，静止内容提供理解所需的上下文。

Mermaid（\`\`\`mermaid 代码块）
   - 适合用清晰的节点和连线呈现流程、调用顺序、状态转换或结构关系。
   - 可按内容选择 flowchart、sequenceDiagram、stateDiagram-v2、classDiagram 等图形。
   - 页面是窄的单栏：超过 4 个节点的流程图用纵向布局（flowchart TD），不要横向排成一长串。
   - 节点文字一律放在双引号里，例如 A["unknown 值"] --> B["typeof 检查"]，避免括号、冒号等符号导致语法错误。
   - 不写样式和主题配置，由页面统一处理。`;

/** 题目里的图解：看图更容易考查理解时才用 */
export function diagramGuide(figureGuidance = DEFAULT_CONTENT_GUIDANCE.figureGuidance): string {
  return `## 图解

${figureGuidance}

确定表达形式后，选择能准确实现它的绘制方式：

1. ${CODE_DIAGRAM_RULES.replace('\n\nMermaid', '\n\n2. Mermaid')}`;
}

/**
 * 讲解的配图要求：每节 1~2 张图，按内容选最合适的形式。
 * illustrations 为 true 时可以把完整绘图说明交给图像模型。
 */
export function lessonFigureGuide(options: { illustrations: boolean }, figureGuidance = DEFAULT_CONTENT_GUIDANCE.figureGuidance): string {
  const forms = options.illustrations
    ? `1. ${ILLUSTRATION_GUIDE}\n\n2. ${CODE_DIAGRAM_RULES.replace('\n\nMermaid', '\n\n3. Mermaid')}`
    : `1. ${CODE_DIAGRAM_RULES.replace('\n\nMermaid', '\n\n2. Mermaid')}`;
  return `## 配图（每节必配）

每节讲解配 1~2 张图，一般 1 张。根据理解需要组织信息；需要第 2 张时，让两张图分担互补的教学作用。

${figureGuidance}

确定表达形式后，选择能准确实现它的绘制方式：

${forms}${options.illustrations ? '\n\n不画插画时，illustrations 为空数组。' : ''}`;
}
