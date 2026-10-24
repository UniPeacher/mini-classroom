import { z } from 'zod';

/** 用户核对的学习目标；正式主题沿用这份目标生成内容。 */
export const TopicBriefSchema = z.object({
  goal: z.string().trim().min(1).max(1000),
  background: z.string().trim().max(500),
  scope: z.array(z.string().trim().min(1).max(200)).min(1).max(8),
});

export const TopicClarificationSchema = z.object({
  reply: z.string().trim().min(1).max(3000),
  brief: TopicBriefSchema.nullable(),
});

export type TopicBrief = z.infer<typeof TopicBriefSchema>;
export type TopicClarification = z.infer<typeof TopicClarificationSchema>;
export interface TopicMessage {
  role: 'user' | 'assistant';
  content: string;
  brief?: TopicBrief | null;
}

export const TopicIdeaSchema = z.string().trim().min(1, '请描述想学的内容').max(2000, '每条消息不超过 2000 字');

/** 供图谱和教学内容共用的已确认目标描述。 */
export function describeTopicBrief(brief: TopicBrief): string {
  return `学习目的：${brief.goal}\n已有基础：${brief.background || '尚未说明，由摸底诊断确认'}\n学习范围：\n${brief.scope.map(item => `- ${item}`).join('\n')}`;
}
