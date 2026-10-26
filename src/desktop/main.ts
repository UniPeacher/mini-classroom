import { appendFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { app, BrowserWindow, dialog, Menu, session, shell, type MenuItemConstructorOptions } from 'electron';
import { type Runtime, startRuntime } from '../server/runtime';
import { canImportDatabase, importDatabase } from './data';

app.setName('微课堂');
// 支持隔离的验证目录，烟测和开发不会读取用户实际的学习记录。
const explicitDataDirectory = app.commandLine.getSwitchValue('user-data-dir');
if (explicitDataDirectory) {
  mkdirSync(resolve(explicitDataDirectory), { recursive: true });
  app.setPath('userData', resolve(explicitDataDirectory));
}

let runtime: Runtime | undefined;
let mainWindow: BrowserWindow | undefined;
let quitting = false;
let importing = false;

const resourceRoot = app.getAppPath();
const migrationsFolder = join(resourceRoot, 'migrations');
const dbPath = join(app.getPath('userData'), 'data', 'weiketang.sqlite');
const windowPreferences = { nodeIntegration: false, contextIsolation: true, sandbox: true };

function reportError(error: unknown): void {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  try {
    const logs = app.getPath('logs');
    mkdirSync(logs, { recursive: true });
    appendFileSync(join(logs, 'main.log'), `${new Date().toISOString()} ${message}\n`);
  } catch {
    // 日志目录不可写时仍保留错误提示，不能让记录日志掩盖原始错误。
  }
}

function isAppUrl(value: string): boolean {
  try {
    return Boolean(runtime && new URL(value).origin === runtime.url);
  } catch {
    return false;
  }
}

function openExternal(value: string): void {
  try {
    const url = new URL(value);
    if ((url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password) {
      void shell.openExternal(url.href).catch(reportError);
    }
  } catch {
    // 生成内容中的非法地址不交给系统处理。
  }
}

/** 限制所有学习窗口，包括“当天回顾”打开的子窗口。 */
function protectWindow(window: BrowserWindow): void {
  window.webContents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) {
      event.preventDefault();
      openExternal(url);
    }
  });
  window.webContents.on('will-redirect', (event, url) => {
    if (!isAppUrl(url)) event.preventDefault();
  });
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isAppUrl(url)) return { action: 'allow', overrideBrowserWindowOptions: { webPreferences: windowPreferences } };
    openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('did-create-window', protectWindow);
}

async function createWindow(): Promise<void> {
  if (!runtime || quitting) return;
  mainWindow = new BrowserWindow({
    title: '微课堂',
    width: 1180,
    height: 820,
    minWidth: 380,
    minHeight: 560,
    show: false,
    icon: join(resourceRoot, 'icon.png'),
    webPreferences: windowPreferences,
  });
  const window = mainWindow;
  protectWindow(window);
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = undefined;
  });
  await window.loadURL(runtime.url);
}

async function launchRuntime(): Promise<void> {
  runtime = await startRuntime({
    dbPath,
    port: 0,
    webRoot: join(resourceRoot, 'web'),
    migrationsFolder,
    // 安装版的模型设置只来自它自己的数据库，不隐式读取开发者的环境配置。
    env: {},
  });
}

async function importLearningData(): Promise<void> {
  if (!runtime || !mainWindow || importing || quitting) return;
  if (!canImportDatabase(runtime.db)) {
    await dialog.showMessageBox(mainWindow, { type: 'info', message: '当前已经有学习记录或设置，不能导入覆盖。', detail: '导入仅适用于尚未开始使用的安装版。原有记录不会被修改。' });
    return;
  }
  importing = true;
  let closingRuntime = false;
  let stopped = false;
  try {
    const selected = await dialog.showOpenDialog(mainWindow, {
      title: '选择旧版微课堂的学习数据库',
      properties: ['openFile'],
      filters: [{ name: '学习数据库', extensions: ['sqlite', 'db'] }],
    });
    if (selected.canceled || !selected.filePaths[0] || quitting) return;
    const confirmation = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      message: '导入这份学习记录？',
      detail: '学习记录和模型设置会一起导入，原文件保持不变。导入后会继续尚未完成的内容生成任务。',
      buttons: ['取消', '导入'],
      defaultId: 0,
      cancelId: 0,
    });
    if (confirmation.response !== 1 || quitting) return;
    // 先停止页面访问与后台任务，避免检查空库之后仍有新内容写入。
    for (const window of BrowserWindow.getAllWindows()) window.destroy();
    closingRuntime = true;
    await runtime.stop();
    stopped = true;
    runtime = undefined;
    await importDatabase(selected.filePaths[0], dbPath, migrationsFolder);
  } catch (error) {
    reportError(error);
    dialog.showErrorBox('没有完成导入', error instanceof Error ? error.message : String(error));
    if (closingRuntime && !stopped) {
      // 停止失败时无法确认旧连接状态，退出后由用户重开，不能再开第二份服务。
      app.exit(1);
    }
  } finally {
    try {
      if (stopped && !quitting) {
        await launchRuntime();
        await createWindow();
      }
    } catch (error) {
      reportError(error);
      dialog.showErrorBox('微课堂无法启动', '请通过日志检查具体原因。学习记录仍保存在原数据目录。');
      app.exit(1);
    }
    importing = false;
    if (!quitting && BrowserWindow.getAllWindows().length === 0) app.quit();
  }
}

function createMenu(): void {
  const template: MenuItemConstructorOptions[] = [];
  if (process.platform === 'darwin') template.push({ role: 'appMenu', label: '微课堂' });
  template.push({
    label: '文件',
    submenu: [
      { label: '导入旧版学习记录…', click: () => { void importLearningData().catch(reportError); } },
      { label: '打开学习数据文件夹', click: () => { void shell.openPath(join(app.getPath('userData'), 'data')).then((error) => { if (error) throw new Error(error); }).catch(reportError); } },
      { type: 'separator' },
      { role: 'quit', label: '退出微课堂' },
    ],
  });
  template.push({ role: 'editMenu', label: '编辑' });
  template.push({ label: '视图', submenu: [{ role: 'reload', label: '重新加载' }, { type: 'separator' }, { role: 'resetZoom', label: '实际大小' }, { role: 'zoomIn', label: '放大' }, { role: 'zoomOut', label: '缩小' }, { role: 'togglefullscreen', label: '切换全屏' }] });
  template.push({ label: '帮助', submenu: [{ label: '打开日志文件夹', click: () => { void shell.openPath(app.getPath('logs')).catch(reportError); } }, { role: 'about', label: '关于微课堂' }] });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const window = mainWindow ?? BrowserWindow.getAllWindows()[0];
    if (window) {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    }
  });
  // 关闭全部窗口即退出，防止用户以为结束后仍在后台调用付费模型。
  app.on('window-all-closed', () => { if (!importing && !quitting) app.quit(); });
  app.on('activate', () => {
    if (!mainWindow && runtime && !importing && !quitting) void createWindow().catch(reportError);
  });
  app.on('before-quit', (event) => {
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    for (const window of BrowserWindow.getAllWindows()) window.destroy();
    // 模型网络请求可能长时间不结束；到期退出后，下次启动从持久任务队列恢复。
    const deadline = setTimeout(() => app.exit(0), 5000);
    void (runtime?.stop() ?? Promise.resolve()).then(() => {
      clearTimeout(deadline);
      app.exit(0);
    }).catch((error) => {
      reportError(error);
      clearTimeout(deadline);
      app.exit(1);
    });
  });
  void app.whenReady().then(async () => {
    app.setAppLogsPath();
    app.setAboutPanelOptions({ applicationName: '微课堂', applicationVersion: app.getVersion(), copyright: 'Copyright © pipdax' });
    await launchRuntime();
    session.defaultSession.setPermissionCheckHandler((_contents, permission, origin) => permission === 'notifications' && isAppUrl(origin));
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => callback(permission === 'notifications' && isAppUrl(contents.getURL())));
    createMenu();
    await createWindow();
  }).catch((error) => {
    reportError(error);
    dialog.showErrorBox('微课堂无法启动', '请检查是否有足够的磁盘空间以及数据目录的读写权限。详细原因已记录在应用日志中。');
    app.exit(1);
  });
}
