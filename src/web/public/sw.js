// 微课堂的 Service Worker：让应用可以安装，并在已安装时发提醒通知。
// 不缓存接口数据：学习内容和记忆状态以服务端为准，离线时不展示过期的内容。
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// 点击提醒通知：打开（或切回）微课堂
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const open = windows.find((w) => 'focus' in w);
      return open ? open.focus() : self.clients.openWindow('/');
    }),
  );
});

// 可安装的条件之一：有 fetch 处理。请求一律直接走网络
self.addEventListener('fetch', () => {});
