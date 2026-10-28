import type { ContentGuidance } from './content-guidance';

/**
 * 学科教学预设：在共用表达规则之上，补充该学科特有的讲法和举例方式。
 *
 * 设计取舍：
 * - 预设只"追加"，不替换共用规则。句长、加粗锚点、列表上限这些排版规则与学科无关，
 *   替换会让不同学科的讲解排版不一致。
 * - 每个预设只写这个学科真正区别于其他学科的地方；"内容要准确"这类通用要求不重复写。
 * - 不写无法核验的绝对结论：不虚构引用、法条、数据、研究出处，也不声称某条规则"现行有效"。
 *   时效性内容只要求标注适用地区与时间点，并提示用户自行核验。
 * - 预设是起点不是终点：用户仍可在设置页改共用引导词。
 *
 * 运行期只由 `composeTeachingGuidance` 使用本文件的数据：某个学科选定的预设 →
 * 追加到共用引导词之后。旧的分组/逐标签覆盖只在升级迁移时读取（见 store/legacy-organization.ts）。
 */

export const SUBJECT_STYLES = [
  'default',
  'stem',
  'programming',
  'language',
  'humanities',
  'business',
  'law',
  'medicine',
  'arts',
] as const;

export type SubjectStyleId = (typeof SUBJECT_STYLES)[number];

export interface SubjectStyle {
  id: SubjectStyleId;
  label: string;
  /** 这个预设适合什么学科，给用户选择时看 */
  description: string;
  /**
   * 预设正文的版本。修改教程或配图要求时必须递增：
   * 教学配置指纹包含它，已生成内容据此判断是否需要重新准备。
   */
  version: number;
  /** 追加到教程引导词之后的学科要求 */
  tutorial?: string;
  /** 追加到配图引导词之后的学科要求 */
  figure?: string;
}

export const SUBJECT_STYLE_INFO: Record<SubjectStyleId, SubjectStyle> = {
  default: {
    id: 'default',
    label: '通用',
    description: '不额外限定学科，按共用表达规则讲。适合还没想清楚属于哪类的主题。',
    version: 1,
  },
  stem: {
    id: 'stem',
    label: '理工科',
    description: '数学、物理、化学、工程等：重推导、公式、量纲和数值验证。',
    version: 2,
    tutorial: `## 学科补充要求：理工科
- 公式先说明每个符号代表什么、单位是什么，再代入计算。符号沿用这个学科常见的标准写法。
- 讲清推导的每一步依据：用了哪条定律、哪个近似、在什么条件下成立。不跳步，也不把结论当条件用。
- 数值例子给出具体数字并算到底，让学习者能自己验算；避免"很大""很小"这类模糊描述。
- 说明适用条件和边界：公式在哪些情况下不适用、近似误差的量级、结论对参数的敏感程度。
- 单位与量纲在推导和结果中保持一致；量纲对不上时结论一定有误，可以据此自查。
- 易混的公式或概念用表格并排对照，列出各自的适用条件和典型使用场景，而不只写定义差异。`,
    figure: `- 理工科的图优先表达结构与过程：受力、传热、电路等物理结构，信号流，反馈回路，状态演化。
- 图的符号与正文公式一致；箭头表示因果或流向，不用装饰性图形代替真实结构。
- 需要表现数量关系时用坐标图，标出坐标轴含义与单位；示意图中的数值标为"示意"。`,
  },
  programming: {
    id: 'programming',
    label: '编程与计算机',
    description: '编程语言、算法、系统设计：重代码行为、边界情况和调试。',
    version: 2,
    tutorial: `## 学科补充要求：编程与计算机
- 代码示例短小、可运行，只保留说明这个知识点必需的语句。语言和版本要说清，例如"Python 3.12"。
- 讲清代码在运行时的实际行为：求值顺序、作用域、内存与类型如何变化，而不只解释语法。
- 明确边界情况：空值、空集合、越界、并发、溢出时会发生什么。这类情况是故障的常见来源，逐条说清。
- 报错信息贴原文并逐行解释，指出错误来自哪一行、哪一层调用。无法确认具体版本行为时明说。
- 区分"能跑"和"正确"：给出一个能运行但结果不对的反例。
- 算法类内容给出时间与空间复杂度，并说明在什么数据规模下这种复杂度会带来实际影响。`,
    figure: `- 优先画执行流程、调用栈、数据在内存中的形态变化，或架构与依赖方向。
- 图里的变量名和类型与代码一致，避免图与代码两套命名。
- 表现时序或并发时用时间轴表示先后和重叠，不用静态方框暗示顺序。`,
  },
  language: {
    id: 'language',
    label: '语言学习',
    description: '外语与语言类：重例句、用法辨析、搭配和语境。',
    version: 2,
    tutorial: `## 学科补充要求：语言学习
- 例句保留目标语言的原文，不译成中文；需要时在原文后附中文直译和自然的中文意译。
  讲解正文仍用简体中文，只有例句和要学习的词语保留目标语言。
- 每个用法至少配一个完整例句，例句要像真实会说的话，不用生硬的造句。
- 讲用法时讲清三件事：什么时候用、什么时候不用、和中文的对应关系在哪里断开。
- 容易混淆的形式（时态、格、介词、近义词）用表格并排对照，各配一个最短对比例句，让差异一眼可见。
- 变形类内容（动词变位、名词变格）给出规则和例外；例外单独列出，标注常见的几个，不声称穷尽。
- 标注语域：书面、口语、正式、俚俗。同一个意思在不同场合的说法可能不同。
- 指出学习者容易与母语习惯混淆的地方，并说明判断依据。
- 发音规则用文字描述发音部位和方法，例如"舌尖抵上齿龈"；音标只作辅助。`,
    figure: `- 语言的图用于对照和结构，不替代例句：变位表、词形变化树、句子成分划分、近义词语义范围对照。
- 表格类图与正文例句一致，标出规则与例外。
- 不用图形化插图代替语言本身的练习；图只辅助看清结构关系。
- 图中的目标语言词语保留原文，说明文字用简体中文。`,
  },
  humanities: {
    id: 'humanities',
    label: '人文社科',
    description: '历史、哲学、社会学、文学：重概念界定、观点对比和论证结构。',
    version: 2,
    tutorial: `## 学科补充要求：人文社科
- 先界定概念再用概念。同一个词在不同学派里含义可能相反，要说明本段用的是哪种含义、由谁提出。
- 讲观点时说明它回应的是什么问题、反对的是什么立场，让学习者能看清论战背景。
- 涉及争议时并排列出主要立场及其最强论证，不替学习者预设结论，也不把某一家之说当成定论。
- 讲清证据类型与效力：史料、统计、个案、思想实验各自能支持什么、不能支持什么。
- 时间与地理背景要具体：哪个时期、哪个地区、什么社会条件。笼统的"古代""西方"没有解释力。
- 抽象论述配一个具体的历史或个人案例，让论证落到可检验的地方。
- 不编造引文、页码或研究出处；无法确认出处时只描述观点内容，并说明出处待核实。`,
    figure: `- 用图表达论证结构（前提如何推出结论）、观点谱系（谁影响了谁、谁反对谁）、时间线或概念关系网。
- 表现思想分歧时用对照结构，让各立场的核心主张与关键差异并列可见。
- 不用装饰性的人物画像或场景插画代替论证结构。`,
  },
  business: {
    id: 'business',
    label: '商科与金融',
    description: '财务、投资、管理、经济：重计算、指标口径和决策场景。',
    version: 2,
    tutorial: `## 学科补充要求：商科与金融
- 每个指标写清计算口径：分子分母各包含什么、用期初还是期末数、是否年化。口径不同结论可能相反。
- 计算题给出完整代入过程并保留中间结果，让学习者能逐步核对。
- 说明结论依赖的假设；假设变了结论如何变化要说出来。
- 用贴近真实决策的场景：要做什么选择、有哪些约束、代价是什么。不只讲定义，要落到决策。
- 涉及风险与收益时，同时讲清期限、流动性和不利情形，不只讲期望收益。
- 制度与规则类内容（税务、会计准则、监管）注明适用地区和时间点，并提示规则可能已调整、需自行核验；
  不编造具体税率或条款编号，也不声称某条规定正在生效；无法确认时只讲一般原理。
- 不引用无法核验的数据或研究结论作为论据。`,
    figure: `- 用图表达资金流、时间价值、权衡关系（如风险与收益）、损益结构或决策树。
- 坐标图标注单位与期间；比率类指标注明口径。
- 数值示意图要与正文计算一致，或明确标为"示意"。`,
  },
  law: {
    id: 'law',
    label: '法律',
    description: '法条、案例与法律实务：重要件拆解、适用边界和类案对照。',
    version: 2,
    tutorial: `## 学科补充要求：法律
- 讲规则时拆成要件：成立需要满足哪几个条件，逐个说明判断标准。
- 说明适用边界：哪些情形看似符合却不适用，哪些情形看似不符却可能通过解释被涵盖。
- 用案例对照：给出一个满足要件的案例和一个处于边界的案例，比较差异点在哪里。
- 区分事实问题与法律问题，区分实体与程序。混在一起会让推理失效。
- 不编造具体条文、案号或判决结论。需要举例时用假设案例，并明确标注"假设案例"。
- 涉及法律变动时只说明"该规则可能随立法与司法解释调整"，提示用户以现行有效文本为准；
  不声称任何条文"现行有效"，也不虚构修改时间。
- 讲清不同结论的论证路径，而不只给一个"正确答案"。`,
    figure: `- 用图表达要件构成、适用流程、请求权基础的选择路径，或类案的差异对照。
- 流程图标出每个判断节点的依据和后果。
- 不用象征性插图（法槌、天平）代替规则结构。`,
  },
  medicine: {
    id: 'medicine',
    label: '医学与生命科学',
    description: '基础医学与临床：重机制链条、鉴别诊断和临床推理。',
    version: 2,
    tutorial: `## 学科补充要求：医学与生命科学
- 机制按因果链条讲：从初始变化到最终表现，每一步说明中间环节，不跳过。
- 讲清"为什么会出现这个表现"，把症状、体征、检查结果与机制对应起来。
- 鉴别诊断说明区分点：哪个特征能把 A 和 B 分开，哪个检查更有鉴别价值。
- 说明检查的局限：假阳性、假阴性、窗口期，以及结果受哪些因素影响。
- 药物类内容写清作用靶点、给药途径、主要不良反应与禁忌，不省略风险信息。
- 不编造具体数值阈值、指南推荐等级或文献出处；不确定时说明"具体阈值与推荐以最新指南为准"。
- 明确这是学习材料，不构成诊疗建议；具体处置以临床规范和执业医师判断为准。`,
    figure: `- 用图表达通路、解剖结构、病理演变过程或诊断决策流程。
- 解剖与结构图的比例、方位要正确，标注与正文术语一致。
- 表现病程时用时间轴标出关键转折点和对应的机制变化。`,
  },
  arts: {
    id: 'arts',
    label: '艺术与设计',
    description: '音乐、绘画、设计、影视：重感知描述、技法拆解和作品对照。',
    version: 2,
    tutorial: `## 学科补充要求：艺术与设计
- 先描述可观察的事实（构图、色彩、节奏、比例），再解释它产生什么效果、为什么。
- 技法要拆到可操作的层面：具体怎么下笔、怎么排版、怎么配器，而不只写"要有层次感"这类空话。
- 用作品对照：把两个处理方式不同的例子并排，指出差别导致的观感差异。
- 讲清历史与风格语境：这个手法在什么时期、什么流派中出现，回应了什么需求。
- 承认审美判断的多样性：给出判断依据，同时说明不同取向的人会怎么看。
- 练习要求具体可执行：改哪个参数、换哪种处理、对比什么效果。
- 不编造作品年代、作者归属或展览信息；无法确认时只描述可见的形式特征。`,
    figure: `- 图本身承担主要表达：作品对照、构图分析、色彩关系、结构拆解、技法步骤分解。
- 分析图标注具体位置与对应的分析结论，不让读者猜箭头指向什么。
- 对照图保持相同尺寸和视角，否则差异无法比较。`,
  },
};

export const DEFAULT_SUBJECT_STYLE: SubjectStyleId = 'default';

export function isSubjectStyleId(value: unknown): value is SubjectStyleId {
  return typeof value === 'string' && (SUBJECT_STYLES as readonly string[]).includes(value);
}

/** 预设正文的版本；未知取值按 0 处理，改坏的数据不会让内容被判为最新 */
export function subjectStyleVersion(id: SubjectStyleId): number {
  return SUBJECT_STYLE_INFO[id]?.version ?? 0;
}

/** 把预设的学科要求追加到共用引导词之后；共用规则始终保留 */
export function appendStyle(base: string, addition: string | undefined): string {
  const extra = addition?.trim();
  if (!extra) return base;
  return `${base.trimEnd()}\n\n${extra}`;
}

/**
 * 生成端与预览共用的唯一合成函数：共用引导词 + 学科预设的补充要求。
 * default 预设不追加任何内容，结果与只用共用规则时逐字相同。
 */
export function composeTeachingGuidance(base: ContentGuidance, id: SubjectStyleId): ContentGuidance {
  const style = SUBJECT_STYLE_INFO[id] ?? SUBJECT_STYLE_INFO.default;
  if (!style.tutorial && !style.figure) {
    return { tutorialGuidance: base.tutorialGuidance, figureGuidance: base.figureGuidance };
  }
  return {
    tutorialGuidance: appendStyle(base.tutorialGuidance, style.tutorial),
    figureGuidance: appendStyle(base.figureGuidance, style.figure),
  };
}

// ---------------------------------------------------------------------------
// 旧版组织方式：分组、逐标签覆盖、扁平映射。
//
// 这些函数只在升级迁移和迁移兼容性测试中使用，运行期不再调用。
// 新模型的唯一解析入口是 src/teaching.ts（学科 → 课程 → 学习主题）。
// ---------------------------------------------------------------------------

/**
 * @deprecated 旧版分组配置，仅用于迁移兼容性测试。
 * 学科分组：一个大类定内容风格，下面挂具体的专业课标签。
 */
export interface SubjectGroup {
  /** 分组名，例如「理工科」「语言」 */
  name: string;
  styleId: SubjectStyleId;
  /** 这个分组下的标签；标签本身不单独定风格，跟随分组 */
  subjects: string[];
}

/**
 * @deprecated 旧版设置形状，仅用于迁移兼容性测试。
 * 兼容早期只有 subjectStyles 扁平映射的数据。
 */
export interface SubjectGroupSettings {
  groups: SubjectGroup[];
  /** 单个标签的风格覆盖 */
  tagStyles?: Record<string, string>;
  /** 旧版的"标签 → 风格"扁平映射 */
  legacyStyles?: Record<string, string>;
}

/** @deprecated 仅用于迁移兼容性测试。某个标签属于哪个分组；没有归组时返回 null */
export function groupOfTag(groups: readonly SubjectGroup[], tag: string | null | undefined): SubjectGroup | null {
  if (!tag) return null;
  return groups.find((g) => g.subjects.includes(tag)) ?? null;
}

/**
 * @deprecated 仅用于迁移兼容性测试，运行期由 src/teaching.ts 解析。
 * 旧版规则下标签实际使用的风格，优先级：标签覆盖 → 分组 → 旧扁平映射 → 通用。
 */
export function styleIdOfTag(settings: SubjectGroupSettings | undefined | null, tag: string | null | undefined): SubjectStyleId {
  if (!tag) return DEFAULT_SUBJECT_STYLE;
  const own = settings?.tagStyles?.[tag];
  if (isSubjectStyleId(own)) return own;
  const group = groupOfTag(settings?.groups ?? [], tag);
  if (group) return isSubjectStyleId(group.styleId) ? group.styleId : DEFAULT_SUBJECT_STYLE;
  const legacy = settings?.legacyStyles?.[tag];
  return isSubjectStyleId(legacy) ? legacy : DEFAULT_SUBJECT_STYLE;
}

/** @deprecated 仅用于迁移兼容性测试。这个标签用的是不是自己的覆盖 */
export function hasOwnStyle(settings: SubjectGroupSettings | undefined | null, tag: string): boolean {
  return isSubjectStyleId(settings?.tagStyles?.[tag]);
}

/** @deprecated 仅用于迁移兼容性测试。设置标签自己的风格；传 null 表示取消覆盖 */
export function withTagStyle(tagStyles: Record<string, string> | undefined, tag: string, styleId: SubjectStyleId | null): Record<string, string> {
  const next = { ...(tagStyles ?? {}) };
  if (styleId === null) delete next[tag];
  else next[tag] = styleId;
  return next;
}

/** @deprecated 仅用于迁移兼容性测试。把标签归到某个分组，并从其他分组里移除 */
export function assignTag(groups: readonly SubjectGroup[], tag: string, groupName: string | null): SubjectGroup[] {
  const cleaned = groups.map((g) => ({ ...g, subjects: g.subjects.filter((s) => s !== tag) }));
  if (groupName === null) return cleaned;
  return cleaned.map((g) => (g.name === groupName ? { ...g, subjects: [...g.subjects, tag] } : g));
}

/** @deprecated 仅用于迁移兼容性测试。清理旧分组：去掉空标签、重复标签和同名分组 */
export function normalizeGroups(groups: readonly SubjectGroup[]): SubjectGroup[] {
  const seen = new Set<string>();
  const out: SubjectGroup[] = [];
  for (const group of groups) {
    const name = group.name.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const subjects = [...new Set(group.subjects.map((s) => s.trim()).filter(Boolean))];
    out.push({ name, styleId: isSubjectStyleId(group.styleId) ? group.styleId : DEFAULT_SUBJECT_STYLE, subjects });
  }
  return out;
}
