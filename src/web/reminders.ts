import { useEffect } from 'react';
import { type Today, api } from './api';

/** 页面开着时，每分钟看一次今天的提醒时段 */
const CHECK_MS = 60 * 1000;
const NOTIFIED_KEY = 'weiketang.notified';

export function notificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function notificationPermission(): NotificationPermission | 'unsupported' {
  return notificationsSupported() ? Notification.permission : 'unsupported';
}

export async function requestNotificationPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (!notificationsSupported()) return 'unsupported';
  return Notification.requestPermission();
}

/** 发一条系统通知：已安装为应用时通过 Service Worker 发，否则直接发 */
export async function showReminder(body: string): Promise<void> {
  if (notificationPermission() !== 'granted') return;
  const options: NotificationOptions = { body, icon: '/icon.svg', tag: 'weiketang-reminder' };
  const registration = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : undefined;
  if (registration) await registration.showNotification('微课堂', options);
  else new Notification('微课堂', options);
}

/** 到点后这么多分钟内仍会提醒；再晚就算漏掉了，不补 */
const SLOT_WINDOW_MINUTES = 60;

const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** 此刻该提醒的时段：已到点、还在提醒窗口内、这个时段还没学过一节，且没达到每日上限 */
export function dueSlot(today: Today): string | null {
  const now = minutesOf(today.now);
  const capped = today.dailySessionCap !== null && today.sessionsToday >= today.dailySessionCap;
  if (capped) return null;
  const slot = today.slots.find((s) => !s.done && now >= minutesOf(s.time) && now < minutesOf(s.time) + SLOT_WINDOW_MINUTES);
  return slot?.time ?? null;
}

/**
 * 提醒时段：到点且这个时段还没学过一节时，发一条系统通知。每个时段每天只提醒一次。
 * 本机运行没有推送服务器，所以只在页面（或已安装的应用）开着时生效；漏掉的时段不补。
 */
export function useReminders(): void {
  useEffect(() => {
    let stopped = false;
    const check = async () => {
      try {
        const today = await api.today();
        const slot = dueSlot(today);
        if (stopped || !slot) return;
        const key = `${today.date} ${slot}`;
        if (readNotified() === key) return;
        writeNotified(key);
        await showReminder(`${slot} 到了，来一节微课堂吧。`);
      } catch {
        // 服务暂时不可用时下一分钟再看
      }
    };
    void check();
    const timer = setInterval(check, CHECK_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);
}

function readNotified(): string {
  try {
    return localStorage.getItem(NOTIFIED_KEY) ?? '';
  } catch {
    return '';
  }
}

function writeNotified(value: string): void {
  try {
    localStorage.setItem(NOTIFIED_KEY, value);
  } catch {
    // 浏览器禁用存储时，最多重复提醒一次
  }
}
