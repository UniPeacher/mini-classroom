# 第一版采用全栈 TypeScript

> 实现状态（2026-10-23）：React + Vite、Node + Hono、SQLite、AI SDK、Zod 与 ts-fsrs 已采用。下文的 `web-push` 没有引入；当前使用页面内通知轮询与 Service Worker 展示通知，没有服务端推送。

前端用 React + Vite 做成 PWA；服务端用 Node + Hono；数据库用 SQLite。模型层用 Vercel AI SDK，可接 OpenAI 兼容接口、Anthropic、Gemini；间隔调度用 `ts-fsrs`；网页推送用 `web-push`。选择全栈 TS 的决定性理由是：AI 生成内容的结构（题目、参考答案、形式、图解代码等）只用 Zod 定义一份，服务端拿它校验 AI 输出，前端拿它渲染，两边不会不同步。另外，只有一种语言，只需维护一套工具链和测试方式。

## Considered Options

- Python 服务端（FastAPI + LiteLLM + py-fsrs）+ TS 前端：依赖同样成熟，但内容结构要在 Python 和 TS 中各维护一份，字段一改两边容易不一致。
