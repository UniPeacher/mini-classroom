# 开发指南

## 从代码到可运行应用

普通用户按 [README](../README.md#开始使用) 安装桌面版即可。参与开发时，先安装 Node.js 24.x，在项目根目录执行：

```bash
npm install --global pnpm@10.11.0
pnpm install --frozen-lockfile
```

macOS / Linux 的源码运行入口如下；这组启停脚本依赖 Bash，Windows 使用它们时需要 WSL：

```bash
pnpm start
```

`pnpm start` 启动后，打开终端打印的地址，默认是 `http://127.0.0.1:6101`，端口占用时自动顺延。关闭浏览器不会停止后台生成，暂时不用时执行 `pnpm stop`；修改 `.env` 后执行 `pnpm restart`。

开发时也可在两个终端分别执行，先启动服务端，再启动前端。这两个命令不依赖 Bash，可用于原生 Windows 开发：

```bash
pnpm dev:server
```

```bash
pnpm dev:web
```

这些命令以前台方式运行，使用 Ctrl+C 停止。不要同时对同一个数据库启动多份服务。`pnpm stop` 只管理 `pnpm start` 记录的进程，不管理手工启动的终端进程。

服务端启动时打开数据库、执行迁移、恢复后台任务，并将实际端口写入 `.run/server.port`。Vite 读取该端口，将 `/api/` 请求转发到服务端，实际页面端口写入 `.run/web.port`。端口改变后重启前端以刷新代理目标。

`pnpm build:web` 输出 `dist/web`，单独这个目录不能运行完整应用。`pnpm start` 用于源码运行，仍使用 Vite 开发服务器；桌面安装包加载正式构建的页面，并自动启动本机服务。

## 构建桌面安装包

推荐在目标系统和 CPU 架构对应的环境中构建并验证。生成其他平台的安装包，不代表已经验证了它在目标电脑上的运行：

```bash
# 生成供 Electron 打包使用的页面、应用代码和数据库迁移
pnpm build:desktop

# 构建当前平台可直接运行的应用目录
pnpm pack:desktop

# 生成当前平台的安装包
pnpm dist:desktop
```

`build:desktop` 的应用内容位于 `dist/desktop-app`；`pack:desktop` 的可运行目录及 `dist:desktop` 的安装包位于 `dist/installers`。后两个命令都会先构建应用，无需逐个执行。打包只包含明确列出的应用资源，不包含项目的 `.env`、`data/` 或 `.run/`。

macOS 输出 DMG 和 ZIP；Windows 输出 NSIS 安装程序；Linux 输出 AppImage 和 DEB。安装包测试与多平台构建见 [发布检查](releasing.md)。当前测试包不需要签名凭据，尚不能视为已完成签名、公证的正式分发包。

构建后可以验证打包应用，例如在 Apple 芯片的 macOS 上执行：

```bash
pnpm smoke:desktop -- "dist/installers/mac-arm64/微课堂.app/Contents/MacOS/微课堂"
```

此命令使用临时学习数据，检查页面启动、设置保存后重启保留、数据目录和退出后的服务停止，不会读取个人记录或调用真实模型。Linux 的无图形界面构建环境用 `xvfb-run -a pnpm smoke:desktop -- "dist/installers/linux-unpacked/mini-classroom"`。这项检查不能代替在对应系统上实际安装、升级和卸载的验收。

## 目录职责与依赖方向

保持单包结构。现有分层已经能分别测试业务规则和 IO 边界，不需要为整理目录拆成 monorepo。

- `src/shared/` 定义 Zod 内容结构；前后端共享格式，避免各维护一套类型。
- `src/domain/` 处理掌握阶段、FSRS、内容选择和认知边缘。这里不访问 HTTP、数据库或模型。
- `src/ai/` 将业务请求转换为模型调用；结构化输出校验失败时有限重试。新增供应商逻辑集中在 gateway，业务服务使用 `StructuredModel` / `Illustrator`。
- `src/store/` 负责 schema、版本化迁移和数据库读写；`src/jobs/` 负责持久化生成任务及重启恢复。
- `src/server/` 组织业务流程。`app.ts` 负责 HTTP 校验和错误映射，`runtime.ts` 负责本机服务及后台任务的启停，`main.ts` 读取源码运行配置；测试通过依赖注入组装应用。
- `src/web/` 负责展示和交互，通过 `api.ts` 调用服务；不能直接引用数据库或模型密钥。
- `src/desktop/` 负责桌面窗口、菜单、应用启停和旧记录导入，复用现有业务服务。

新增规则优先放进对应层，避免页面直接决定记忆状态，或在纯业务规则里加入 IO。术语见 [CONTEXT.md](../CONTEXT.md)，历史决定见 [adr/](adr/)。`plans/` 与 `archive/` 用于理解历史，不是当前功能承诺。

## 环境配置

以下配置用于从项目根目录启动的源码版。`.env` 在服务端启动时读取；修改后需要重启。样例中的模型信息默认留空，可在设置页完成首次配置。桌面版使用自己的设置页和数据目录，不读取项目的 `.env`，也不采用下面的 `DB_PATH` 或 `PORT`。

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

桌面版通过 **文件 → 打开学习数据文件夹** 打开实际保存位置。默认目录为：

- macOS：`~/Library/Application Support/微课堂/data/`。
- Windows：`%APPDATA%\微课堂\data\`。
- Linux：`$XDG_CONFIG_HOME/微课堂/data/`，未设置该变量时为 `~/.config/微课堂/data/`。

应用和学习数据分别保存，覆盖安装新版本不会替换该目录。第一次从源码版切换时，正常停止旧服务，再使用 **文件 → 导入旧版学习记录…** 选择旧数据库。导入会读取一致快照，在副本上验证和升级；仅允许导入到还没有用户记录或已保存设置的桌面版，不改写源文件。导入后可能继续旧的生成任务，因此仍应确认模型配置和费用预期。

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
