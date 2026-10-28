import {
  DEFAULT_SUBJECT_STYLE,
  SUBJECT_STYLE_INFO,
  type SubjectStyleId,
  isSubjectStyleId,
} from '../shared/subject-styles';

/**
 * 注入生成任务的教学上下文：某门课程所属学科选定的教学预设。
 *
 * 目的是让图谱、摸底、拆解、提问、速查和批改都能按同一门课程的教学习惯来写，
 * 而不再只依据主题名称猜测学科。
 *
 * 边界：
 * - 全部字段可选；不传时与改动前的行为完全一致（向后兼容）。
 * - 判分器的判定标准、输出结构与安全约束不随之改变：判分只带上学科名称这类
 *   背景信息，不把整套排版与写作规则塞进判分提示词。
 * - 这里不重复推导配置，只接收已经由 src/teaching.ts 解析出的预设 id。
 */
export interface TeachingContext {
  presetId: SubjectStyleId;
  /** 预设的展示名，例如"理工科" */
  label: string;
  /** 所属学科名；未归类时为 null */
  disciplineName?: string | null;
  /** 所属课程名；未归类时为 null */
  courseName?: string | null;
  /**
   * 这个学科对内容的要求摘要（预设正文）。给讲解、出题、拆解、提问、速查使用；
   * 判分不使用，避免把整套写作与排版规则塞进判分器。
   */
  pedagogy?: string;
}

/** 由已解析的预设 id 构造教学上下文；不传或未知时返回 null，调用方沿用原提示词 */
export function teachingContextOf(
  presetId: SubjectStyleId | string | null | undefined,
  extra: { disciplineName?: string | null; courseName?: string | null } = {},
): TeachingContext | null {
  if (!presetId) return null;
  const id = isSubjectStyleId(presetId) ? presetId : DEFAULT_SUBJECT_STYLE;
  const style = SUBJECT_STYLE_INFO[id];
  return {
    presetId: id,
    label: style.label,
    disciplineName: extra.disciplineName ?? null,
    courseName: extra.courseName ?? null,
    pedagogy: style.tutorial,
  };
}

/** 只有一个学科名时的最简上下文（判分、联结批改、申诉使用） */
export function teachingContextLabel(presetId: SubjectStyleId | string | null | undefined): TeachingContext | null {
  const context = teachingContextOf(presetId);
  return context ? { presetId: context.presetId, label: context.label } : null;
}

/** 课程与学科背景的一句话，未提供时为空字符串 */
export function describeTeachingScope(context: TeachingContext): string {
  const parts: string[] = [];
  if (context.disciplineName) parts.push(`学科：${context.disciplineName}`);
  if (context.courseName) parts.push(`课程：${context.courseName}`);
  parts.push(`教学预设：${context.label}`);
  return parts.join('；');
}

/**
 * 给内容生成任务（图谱、摸底、拆解、提问、速查）追加的学科要求小节。
 * default 预设没有补充要求，返回空字符串，提示词保持原样。
 */
export function teachingContextSection(context: TeachingContext | null | undefined, heading = '学科教学要求'): string {
  if (!context) return '';
  const scope = describeTeachingScope(context);
  const pedagogy = context.pedagogy?.trim();
  if (!pedagogy) {
    return context.presetId === DEFAULT_SUBJECT_STYLE ? '' : `\n${scope}\n- 内容要符合这个学科的实际表达习惯与常用术语。\n`;
  }
  return `\n${scope}\n\n${pedagogy}\n`;
}

/**
 * 给判分、联结批改与申诉的紧凑背景：只说明学科，不附带写作与排版要求。
 * 判定标准、输出结构与安全约束仍由任务本身的规则决定。
 */
export function teachingContextForGrading(context: TeachingContext | null | undefined): string {
  if (!context) return '';
  const parts: string[] = [];
  if (context.disciplineName) parts.push(`学科：${context.disciplineName}`);
  parts.push(`教学预设：${context.label}`);
  return `\n（内容背景：${parts.join('；')}。批改标准与输出结构不变。）\n`;
}
