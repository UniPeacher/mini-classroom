import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright';

const executable = process.argv.slice(2).find((argument) => argument !== '--');
if (!executable) throw new Error('请传入已打包的微课堂可执行文件路径。');
const executablePath = resolve(executable);
const directory = await mkdtemp(join(tmpdir(), 'weiketang-desktop-smoke-'));
const userData = join(directory, 'user-data');
const pageErrors = [];
let application;

/** 启动真正打包的应用；学习记录和模型设置全部隔离在临时目录。 */
async function launch() {
  const instance = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
    timeout: 30000,
  });
  const page = await instance.firstWindow();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.getByRole('navigation', { name: '主导航' }).waitFor();
  assert.equal(await page.title(), '微课堂');
  const origin = new URL(page.url()).origin;
  assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  const identity = await instance.evaluate(({ app, BrowserWindow }) => ({
    packaged: app.isPackaged,
    data: app.getPath('userData'),
    sandbox: BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences().sandbox,
    contextIsolation: BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences().contextIsolation,
    nodeIntegration: BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences().nodeIntegration,
  }));
  assert.equal(identity.packaged, true);
  assert.equal(identity.data, userData);
  assert.equal(identity.sandbox, true);
  assert.equal(identity.contextIsolation, true);
  assert.equal(identity.nodeIntegration, false);
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  const health = await page.evaluate(async () => (await fetch('/api/health')).json());
  assert.deepEqual(health, { ok: true, devMode: false });
  return { instance, page, origin };
}

/** 关闭最后一个窗口，确认整个应用退出，接口端口不再响应。 */
async function closeAndVerify(instance, origin) {
  const exited = instance.waitForEvent('close', { timeout: 15000 });
  await instance.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) window.close();
  });
  await exited;
  await assert.rejects(fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(2000) }));
}

try {
  const first = await launch();
  application = first.instance;
  const repeatedLaunch = spawn(executablePath, [`--user-data-dir=${userData}`], { stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });
  try {
    const [exitCode] = await once(repeatedLaunch, 'exit', { signal: AbortSignal.timeout(15000) });
    assert.equal(exitCode, 0);
    assert.equal(first.instance.windows().length, 1);
    assert.equal((await fetch(`${first.origin}/api/health`)).status, 200);
  } finally {
    if (repeatedLaunch.exitCode === null) repeatedLaunch.kill();
  }
  await first.page.getByRole('link', { name: '设置', exact: true }).click();
  await first.page.getByRole('heading', { name: '设置', exact: true }).waitFor();
  await first.page.getByRole('link', { name: '个性化', exact: true }).click();
  await first.page.getByRole('heading', { name: '个性化', exact: true }).waitFor();
  // 通过页面正在使用的接口写入真实数据库，不访问模型服务。
  const saved = await first.page.evaluate(async () => {
    const response = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionMinutes: 17 }),
    });
    return response.status;
  });
  assert.equal(saved, 200);
  await closeAndVerify(first.instance, first.origin);
  application = undefined;
  assert.ok((await readFile(join(userData, 'data', 'weiketang.sqlite'))).length > 0);

  const second = await launch();
  application = second.instance;
  const settings = await second.page.evaluate(async () => (await fetch('/api/settings')).json());
  assert.equal(settings.settings.sessionMinutes, 17);
  // 原有回顾页使用新窗口；确认桌面壳没有让这个入口失效。
  const popupReady = second.instance.waitForEvent('window');
  await second.page.evaluate(() => window.open(`${location.origin}/#/review/2026-10-26`, '_blank'));
  const popup = await popupReady;
  await popup.waitForLoadState('domcontentloaded');
  assert.equal(new URL(popup.url()).origin, second.origin);
  await popup.close();
  await closeAndVerify(second.instance, second.origin);
  application = undefined;
  assert.deepEqual(pageErrors, []);
  console.log('安装包验证通过：独立启动、重复启动保护、页面与接口、沙箱隔离、记录持久化、回顾子窗口、退出停止服务。');
} finally {
  if (application) await application.close();
  await rm(directory, { recursive: true, force: true });
}
