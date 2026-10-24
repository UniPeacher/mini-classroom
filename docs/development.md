# 开发指南

## 从代码到可运行应用

先按 [README](../README.md) 安装 Node.js 24.x 与 pnpm 10.11.0。`pnpm start` 适合本机日常运行；开发时可在两个终端分别执行，先启动服务端，再启动前端：

```bash
pnpm dev:server
```

```bash
pnpm dev:web
```

这些命令以前台方式运行，使用 Ctrl+C 停止。不要同时对同一个数据库启动多份服务。`pnpm stop` 只管理 `pnpm start` 记录的进程，不管理手工启动的终端进程。

服务端启动时打开数据库、执行迁移、恢复后台任务，并将实际端口写入 `.run/server.port`。Vite 读取该端口，将 `/api/` 请求转发到服务端，实际页面端口写入 `.run/web.port`。端口改变后重启前端以刷新代理目标。

`pnpm build:web` 输出 `dist/web`；它不是完整服务部署包。`pnpm start` 仍然运行 Vite 开发服务器，本项目没有已验证的生产部署流程。

## 目录职责与依赖方向

保持单包结构。现有分层已经能分别测试业务规则和 IO 边界，不需要为整理目录拆成 monorepo。

- `src/shared/` 定义 Zod 内容结构；前后端共享格式，避免各维护一套类型。
- `src/domain/` 处理掌握阶段、FSRS、内容选择和认知边缘。这里不访问 HTTP、数据库或模型。
- `src/ai/` 将业务请求转换为模型调用；结构化输出校验失败时有限重试。新增供应商逻辑集中在 gateway，业务服务使用 `StructuredModel` / `Illustrator`。
- `src/store/` 负责 schema、版本化迁移和数据库读写；`src/jobs/` 负责持久化生成任务及重启恢复。
- `src/server/` 组织业务流程。`app.ts` 负责 HTTP 校验和错误映射，`main.ts` 创建真实依赖并启动 worker；测试通过依赖注入组装应用。
- `src/web/` 负责展示和交互，通过 `api.ts` 调用服务；不能直接引用数据库或模型密钥。

新增规则优先放进对应层，避免页面直接决定记忆状态，或在纯业务规则里加入 IO。术语见 [CONTEXT.md](../CONTEXT.md)，历史决定见 [adr/](adr/)。`plans/` 与 `archive/` 用于理解历史，不是当前功能承诺。

## 环境配置

从项目根目录启动。`.env` 在服务端启动时读取；修改后需要重启。样例中的模型信息默认留空，可在设置页完成首次配置。

- `MODEL_PROVIDER`：`openai-compatible`、`anthropic` 或 `google`。
- `MODEL_BASE_URL`、`MODEL_NAME`、`MODEL_API_KEY`：文本模型连接信息；兼容格式需要明确基础地址。远程服务应使用 HTTPS，本地代理可使用 HTTP。
- `MODEL_REASONING_EFFORT`：留空使用模型默认，也可按供应商能力设置；不保证每个模型支持所有强度。
- `MODEL_SUPPORTS_STRUCTURED_OUTPUTS`：默认启用；值为 `false` 时使用兼容 JSON 模式，结果仍经结构校验。
- `IMAGE_MODEL_NAME`：留空禁用图像模型。`IMAGE_BASE_URL` / `IMAGE_API_KEY` 留空时沿用文本配置；文本为非兼容格式时，需要单独填写图像接口地址。
- `PORT`：接口首选端口，默认 6201。`DB_PATH`：数据库路径，默认 `data/weiketang.sqlite`，相对路径从项目根目录解析。
- `DEV_MODE`：默认关闭。仅在明确测试时间变化时设为 `true`，允许 `X-Dev-Now` 请求头模拟时间；普通使用不要开启。
- `SESSION_BUDGET_SECONDS`、`MAX_NEW_PER_SESSION`：未保存学习设置前的默认节奏。`GENERATION_CONCURRENCY` 控制补池模型请求并发量。

AI 设置保存后使用数据库中的整份配置，继续修改 `.env` 不会覆盖它；学习设置也以数据库已保存值为准。调试“配置怎么没有生效”时，先检查设置页。不要通过删除数据库来切换配置。

## 修改数据结构与保留个人数据

修改 `src/store/schema.ts` 后运行：

```bash
pnpm db:generate
```

审阅新 SQL 和 `src/store/migrations/meta/` 快照，确保迁移适用于已有数据，再一并提交。不要改写已经提交的迁移。正常启动会自动应用新迁移，无需单独运行同步命令；不要用 `drizzle-kit push` 替代版本化迁移。

测试迁移时使用临时数据库。SQLite 正在写入时不能只复制主文件而忽略 WAL；需要转移个人数据时先正常停止服务，再保留完整 `data/` 目录。源码 Git 历史不包含个人学习数据库；应用内 Markdown 导出也不等于可恢复的完整数据库快照。

## 验证修改

```bash
# 开源准备与 PR 的基本验收
pnpm check

# 修改特定业务时可先跑相关文件
pnpm exec vitest run tests/e2e/topic-planning.test.ts

# 只检查启停脚本语法，不启动服务
/bin/bash -n start.sh
/bin/bash -n stop.sh
/bin/bash -n restart.sh
```

`pnpm check` 包括源码、测试、脚本的 TypeScript 检查，全部自动测试和前端构建。自动测试使用假模型与内存 SQLite，不需要 `.env`；端口顺延测试会绑定本机临时端口，需要环境允许监听。

`tests/domain` 验证业务规则，`tests/ai` 验证模型契约，`tests/e2e` 使用进程内 HTTP 请求验证完整业务链。`tests/web` 主要验证前端逻辑、静态渲染和接口类型。这些测试不能代替浏览器视觉验收或真实供应商验证。

手动验证真实模型时，可在已配置 `.env` 后运行：

```bash
pnpm smoke:ai "TypeScript 常用技能"
```

这会向真实服务发送请求并产生费用，读取的是 `.env` / 进程环境，**不会使用设置页数据库配置**，也不会写入学习数据库。CI 不执行此命令。

依赖检查使用 npm 官方接口，部分镜像不提供审计 API：

```bash
pnpm audit --registry=https://registry.npmjs.org
```

依赖由 `pnpm-lock.yaml` 锁定。`package.json` 的 esbuild 定向覆盖用于修复 drizzle-kit 间接依赖的 [GHSA-67mh-4wv8-2f99](https://github.com/evanw/esbuild/security/advisories/GHSA-67mh-4wv8-2f99)；上游依赖链更新后，可重新核验是否移除覆盖。
