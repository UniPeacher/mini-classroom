# 版本发布检查

适用范围：把当前源码仓库公开到 GitHub。当前支持本机单用户运行，不包含公网网站部署或 npm 包发布。`package.json` 的 `private: true` 防止误发 npm 包，不影响 GitHub 开源。

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
2. 推送待发布源码，确认 GitHub Actions 检查成功，再创建对应的版本标签。
3. 从标签生成源码包，检查包内版本、文件范围和 SHA-256 校验值。
4. 创建同版本的 GitHub Release，附上用户可理解的更新说明、源码包与校验文件。
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

涉及 schema 时检查新增迁移，并验证新建数据库及已有数据的升级路径。涉及真实模型兼容性时，由维护者在有费用预期的前提下手动验证，不能用模拟模型测试冒充供应商验收。只发布源码时不提交 `dist/`、`node_modules/` 或个人 `data/`。

GitHub 操作依据：[pnpm 的 CI 指南](https://pnpm.io/continuous-integration)、[GitHub 私密漏洞报告设置](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository)。实际远程开关仍需仓库创建后核对。
