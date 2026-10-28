# 学科与课程重构验证记录（2026-10-28）

## 结果

- `pnpm typecheck` 通过。
- `pnpm exec vitest run --exclude tests/listen.test.ts`：54 个文件、576 项测试通过。
- `pnpm build:desktop` 通过。
- 已部署的桌面程序 `pnpm smoke:desktop -- D:/app/mini-classroom/微课堂.exe` 通过：独立启动、重复启动保护、页面/API、沙箱、重启持久化、回顾子窗口、退出停止服务。
- 公式渲染与 FSRS 核心文件未修改：RichMarkdown.tsx、math.ts、diagram.ts、domain/memory.ts。

## 已确认的环境基线失败

`tests/listen.test.ts` 单独复测仍有 5 个失败：固定 46102–46502 端口范围监听时出现 EADDRINUSE，部分用例继而超时。本次未修改端口逻辑，也未删除这些断言。上述 576 项统计明确排除了该文件，并不声称完整 `pnpm check` 全绿。

## 隔离界面验收

使用 `scripts/acceptance-organization.ts`，内存数据库、假模型、三个预置主题，无真实学习数据或收费模型。

实际验证：

1. 从侧栏进入管理页，创建理工科学科并选择其预设。
2. 从所选学科直接创建液压传动课程。
3. 勾选未归类主题，保存前看到受影响课程、主题和待备内容确认；保存后树、课程列表、侧栏同步更新。
4. 非空课程删除按钮禁用并说明原因。
5. 按课程选择学习范围，预览只包含该课程主题；切范围时旧数据隐藏，不把新标签与旧预览混显。
6. 实际开始课堂后，学习页可恢复；返回今天页时旧课堂独立显示，下一节预览不被旧进度替代。
7. 实际教学预览显示服务端来源「理工科 / 液压传动」及对应理工科追加要求，不由界面猜测。
8. 编辑共用引导词后离开，会出现留在此页/放弃修改并离开；选择留下时草稿文本仍在。
9. 管理页在 1280px 与 760px 视口无文档级横向溢出。

验收中发现并修复：恢复课堂漏传 resume、旧课堂重复替换下一节、切范围旧预览闪现、预览接口字段误适配、影响评估失败仍保存、移出课程漏评估、学科详情缺新建课程入口。

## 备份副本升级验证

先正常确认微课堂不在运行，再完整备份程序与 data/。使用 `scripts/verify-organization-upgrade.ts` 只在备份的临时副本上打开和升级：

- 3 个主题、38 个知识点、23 次作答完整保留。
- 迁移生成 2 个学科、2 门课程，关联 3 个主题，报告警告为 0。
- attempts、items、jobs、knowledge_points、memory_states、relations、session_items、sessions、topics、cheatsheets、connections、existing_knowledge、placements、ask_threads、asks、illustrations、topic_drafts 原有列的全部记录逐表相同。
- 原始 user_settings JSON 未改变；备份源文件校验未改变。
- 再次打开副本通过，不重复迁移。

## 本机部署与回滚

最终完整备份目录：`D:/app/mc-backups/20261028-212649-019/`。

包含旧 app.asar、app.asar.unpacked、完整 data/ 和 SHA256 清单 manifest.json。新程序已部署到 `D:/app/mini-classroom/resources/`；部署与烟测未打开真实数据库。真实数据库在用户正常启动新版时才自动升级。

回滚必须先关闭软件，恢复同一备份里的程序资源与 data/，不要只替换旧程序继续使用已经升级的数据。备份中包含模型配置等私密内容，只保留在本地，不上传。

本轮未创建 Git 提交、未推送远端、未创建或重开 PR。
