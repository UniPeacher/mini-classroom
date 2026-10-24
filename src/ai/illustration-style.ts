/**
 * 教学配图的提示词。
 * 文字模型根据知识内容规划教学作用、表达形式和画面，输出完整绘图说明；
 * 交给图像模型时补充准确性、画布和可读性要求。
 */
import type { IllustrationRequest } from '../shared/content';
import { DEFAULT_CONTENT_GUIDANCE } from '../shared/content-guidance';

/** 图像尺寸：横向 3:2，绘图说明按学习页的单栏宽度安排信息 */
export const ILLUSTRATION_SIZE = '1536x1024';

/** 给文字模型的绘图说明要求：把教学设计完整交给图像模型 */
export const ILLUSTRATION_GUIDE = `图像模型绘图
   - 适合需要表现情境、形态、空间感的画面，也可以根据教学需要绘制综合图解。
   - 需要逐字准确的代码、公式、数值或复杂连接关系时，优先用 SVG、Mermaid 或正文承载这些内容。
   - 在讲解里配图出现的位置单独写一行 ![一句话说明这张图帮助理解什么](illustration:key)，key 用英文短横线，例如 arrow-this。
   - 在 illustrations 里为每张图写一项：
     - key：与正文引用一致。
     - prompt：可独立交给图像模型的完整中文绘图说明。写明知识内容、学习者需要形成的理解、选定的表达形式、各部分如何组织与连接、阅读顺序、需要准确呈现的标签和符号，以及适合内容的视觉风格。图像模型看不到讲解正文，所需的知识、条件和示例必须在这里写全。
   - 画布为横向 3:2，展示在学习页的窄单栏中。组合场景、流程、对照或局部放大时，安排清晰的主次关系和足够大的文字。`;

/** 保留文字模型的教学设计，补充图像输出的准确性与可读性要求 */
export function illustrationPrompt(request: IllustrationRequest, figureGuidance = DEFAULT_CONTENT_GUIDANCE.figureGuidance): string {
  return [
    '请根据以下绘图说明，绘制一张帮助学习者理解知识的教学配图。',
    '',
    '配图引导词：',
    figureGuidance,
    '',
    '本图具体说明（已经结合知识内容与本节要求，具体画面以此为准）：',
    request.prompt,
    '',
    '准确呈现说明中的概念、关系、条件、数据和符号，示意内容应与真实数据明确区分。',
    '画布为横向 3:2，按说明安排各部分的主次和阅读顺序，四周留足边距，图形和文字完整显示，不被裁切。',
    '标注使用简体中文，专业名称、代码和数学符号按说明保留。文字靠近对应对象，避免遮挡，在学习页单栏显示时清晰可读。',
  ].join('\n');
}
