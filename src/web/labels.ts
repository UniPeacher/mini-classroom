import type { ItemPurpose, Stage } from './api';

/** 掌握阶段，按阶梯顺序 */
export const STAGES: Stage[] = ['unlearned', 'inferred', 'understand', 'recall', 'apply', 'retain'];

export const STAGE_LABEL: Record<Stage, string> = {
  unlearned: '未学',
  inferred: '推断掌握',
  understand: '理解',
  recall: '回忆',
  apply: '应用',
  retain: '保持',
};

export const PURPOSE_LABEL: Record<ItemPurpose, string> = {
  new: '新学',
  advance: '重讲',
  contrast: '对比讲解',
  review: '复习',
  spot_check: '抽查',
  connection: '联结练习',
};

export const ERROR_LABEL = { misconception: '误解', forgetting: '遗忘' } as const;
export const RATING_LABEL = { hard: '困难', good: '良好', easy: '轻松' } as const;
export const PRIORITY_LABEL: Record<number, string> = { 1: '低', 2: '中', 3: '高' };

export const OPTION_LETTERS = ['A', 'B', 'C', 'D', 'E'];

/** "10月20日 周二" */
export function formatDay(day: string): string {
  return new Date(`${day}T00:00:00`).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' });
}

/** "10/28 14:37" */
export function formatTime(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** 距现在多久之后："3 天后""今天" */
export function relativeDue(iso: string, now = new Date()): string {
  const days = Math.round((new Date(iso).getTime() - now.getTime()) / (24 * 3600 * 1000));
  if (days <= 0) return '已到期';
  if (days === 1) return '明天';
  return `${days} 天后`;
}
