# 版本发布检查

适用范围：发布源码和供本机单用户使用的桌面安装包，不包含公网网站部署或 npm 包发布。`package.json` 的 `private: true` 防止误发 npm 包，不影响桌面打包与 GitHub 发布。

## v1.2.0 桌面安装包

桌面版提供 macOS 的 DMG / ZIP、Windows 的 NSIS EXE，以及 Linux 的 AppImage / DEB。第一版采用手动更新，学习数据保存在用户目录，升级时不随应用文件一起替换。

**当前包属于测试包，尚未完成 macOS 开发者签名、公证及 Windows 代码签名。**生成安装包不等于完成对应系统的安装验收。macOS Intel、Windows、Linux 仍需在相应平台验证后才能声明可用；构建记录与发布说明应分别列明“已生成”“打包应用已运行”和“安装、升级已验证”。

2026-10-26 本地验证结果：

- 已生成 macOS arm64 / x64 的 DMG 和 ZIP、Windows x64 EXE、Linux x64 AppImage 和 DEB，共 7 个文件；校验值位于同目录的 `SHA256SUMS.txt`。
- Apple 芯片版通过 DMG 完整性检查、本地临时签名检查及只读镜像内启动验证。独立启动、重复启动保护、设置保存后重启保留、回顾子窗口及退出后服务停止均通过。
- Intel 版通过本机 Rosetta 功能验证与临时签名检查；首次运行曾超过 30 秒测试超时，重试通过，尚未完成原生 Intel 电脑验收。
- Windows、Linux 已检查安装包格式、版本及包内容，未在目标系统运行；GitHub 四平台工作流尚未执行。
- 类型检查、41 个测试文件中的 399 项自动测试通过，依赖审计未发现已知漏洞。安装内容不包含个人数据库、配置和日志。

macOS 的临时签名用于校验本地包完整性，不等于 Apple 开发者签名或公证。现有验证不包含真实付费模型调用、不同桌面版本之间的覆盖升级或卸载。

在完成依赖安装、类型检查和自动测试后，执行 `pnpm dist:desktop` 构建当前平台。产物位于 `dist/installers/`。需要明确架构时，在相应构建环境使用：

```bash
# Apple 芯片的 macOS
pnpm dist:desktop --mac --arm64

# Intel 的 macOS
pnpm dist:desktop --mac --x64

# x64 Windows
pnpm dist:desktop --win --x64

# x64 Linux
pnpm dist:desktop --linux --x64
```

推荐在目标系统上完成构建和验收。SQLite 原生模块、系统安装程序、权限和桌面行为都需要对应平台的检查，不能用另一平台上的源码测试代替。

### 自动构建

`.github/workflows/desktop.yml` 在手动运行或推送 `v*` 标签时触发，分别使用 macOS 15 arm64、macOS 15 Intel、Windows Server 2022 x64 和 Ubuntu 22.04 x64 构建。每个任务先执行 `pnpm typecheck` 和 `pnpm test`，再构建安装包，并用临时数据启动打包应用进行验证；Linux 使用虚拟显示环境。

成功后，从对应 Actions 运行的 **Artifacts** 下载安装包及 `SHA256SUMS.txt`。产物保留 30 天；工作流不会创建或发布 GitHub Release，也不要求提供签名密钥。四个平台任务全部通过后，仍要补齐下面的安装验收。

### 安装与升级验收

使用临时数据完成以下检查，再填写发布结果：

1. 安装后可从应用菜单启动，无需另外安装 Node.js、pnpm 或 WSL；首页与模型设置可打开。
2. 保存设置、退出、重新打开后内容仍在；重复打开应用只激活现有窗口。
3. 关闭所有窗口会退出应用并停止后台生成；无法继续连接原来的本机服务。
4. 在尚未使用的桌面版中导入旧记录，核对学习主题、作答和设置；原数据库保持不变，已有桌面记录不能被导入覆盖。
5. 覆盖安装新版后记录保留；检查系统中的卸载行为，并在发布说明中说明是否保留学习数据。
6. 若发布签名版本，分别核验 macOS 签名与公证结果、Windows 签名状态。未完成时继续标为测试包，不提供关闭系统安全功能的安装方法。

打包应用的快速检查方式见 [开发指南](development.md#构建桌面安装包)。自动检查不调用真实模型；涉及模型连接与生成时，须由维护者确认费用后单独验收。

## v1.1.0 本地验证（2026-10-24）

目标仓库为 [pipdax/mini-classroom](https://github.com/pipdax/mini-classroom)，公开分支使用 `master`。源码包只包含版本标签对应的文件，不包含个人配置、学习数据、日志和依赖目录。

已完成的核查：

- 干净目录按锁文件离线安装成功，环境为 Node.js 24.14.0、pnpm 10.11.0。
- TypeScript 检查通过；39 个测试文件、373 项自动测试通过；前端构建通过。
- 用临时数据库验证从 v1.0.0 升级：7 张表的既有学习内容和记录完整保留，新字段与新表可用，重复启动正常。
- 插图重试、动态生成提示、失败恢复和成功显示通过桌面与窄屏浏览器验证；真实课程中的失败插图已成功恢复。
- npm 官方依赖审计为零已知漏洞。
- Git 跟踪文件及本地历史经过敏感路径与凭据模式检查，未发现匹配项；模式检查不能证明不存在所有形式的敏感信息。
- 启停脚本逐个通过 Bash 语法检查，Git 差异检查通过。

这些结果来自本地 macOS 环境；发布时还需确认 GitHub 托管的 Linux CI 结果。前端构建仍有 Mermaid 相关大分块警告，不影响本次构建完成。

## GitHub 发布步骤

1. 更新 `package.json` 版本号，完成下面的必要检查并提交。
2. 推送待发布源码，确认基础 CI 成功，再创建对应的版本标签，等待桌面安装包工作流完成。
3. 从标签生成源码包，下载桌面构建产物，核对包内版本、文件范围和 SHA-256 校验值，并完成对应平台的安装验收。
4. 手动创建同版本的 GitHub Release，附上用户可理解的更新说明、已验证平台、签名状态、源码包、安装包与校验文件。测试包明确使用预发布标记。
5. 核对公开仓库、默认分支、Release 和附件确实可访问；检查私密漏洞报告及 GitHub 提供的安全功能状态。

## 每次更新的必要检查

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm audit --registry=https://registry.npmjs.org
/bin/bash -n start.sh
/bin/bash -n stop.sh
/bin/bash -n restart.sh
git diff --check
git status --short
```

涉及 schema 时检查新增迁移，并验证新建数据库及已有数据的升级路径。涉及真实模型兼容性时，由维护者在有费用预期的前提下手动验证，不能用模拟模型测试冒充供应商验收。安装包作为发布附件，不提交 `dist/`、`node_modules/` 或个人 `data/`。

GitHub 操作依据：[pnpm 的 CI 指南](https://pnpm.io/continuous-integration)、[GitHub 私密漏洞报告设置](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository)。实际远程开关仍需仓库创建后核对。
