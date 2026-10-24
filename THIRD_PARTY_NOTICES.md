# 第三方来源与许可

项目原创代码按根目录 [LICENSE](LICENSE) 中的 MIT 许可分发。第三方材料保留各自的版权和许可；本项目的 MIT 声明不能替第三方授予尚未取得的权利。

## 写作原则的来源

`src/ai/writing-style.ts` 按学习场景改编了下列 MIT 许可提示词中的写作原则，没有复制其工具代码：

1. [i-have-adhd](https://github.com/ayghri/i-have-adhd/tree/1ecea1993b7fce257ffbd686c070948b5e07eda6)，Copyright (c) 2026 Ayoub Ghriss；[上游 LICENSE](https://github.com/ayghri/i-have-adhd/blob/1ecea1993b7fce257ffbd686c070948b5e07eda6/LICENSE)。
2. [gpt-with-taste](https://github.com/NB-Corp/gpt-with-taste/tree/079fb262b4d7932515ba4e6341fd57b6f2122f4a)，Copyright (c) 2026 GPT with Taste contributors；[上游 LICENSE](https://github.com/NB-Corp/gpt-with-taste/blob/079fb262b4d7932515ba4e6341fd57b6f2122f4a/LICENSE)。

两项均适用以下 MIT 条款，保留相应版权声明：

```text
MIT License

Copyright (c) 2026 Ayoub Ghriss
Copyright (c) 2026 GPT with Taste contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

gpt-with-taste 的当前上游许可证另列 `Copyright (c) 2026 X-T-E-R (adapted TOML helper)`，并注明 `src/toml-overlay.mjs` 适配了 nb-codex-main 的扫描与行补丁代码；微课堂没有包含该 helper。完整上游声明可通过上述固定版本链接查看。

## npm 依赖和生成内容

依赖版本由 `pnpm-lock.yaml` 固定，各包许可和版权以所安装包内的 LICENSE / NOTICE 为准。分发编译产物时仍须保留适用的第三方声明，不能仅附本项目许可证就视为覆盖所有依赖。

2026-10-23 的安装包清单包含 MIT、Apache-2.0、ISC、BSD，以及 `elkjs` 的 EPL-2.0、`lightningcss` 的 MPL-2.0 等许可；不能把全部依赖统称为 MIT。`pnpm licenses list` 将 `khroma@2.1.0` 标为 Unknown，是其包元数据缺少 license 字段；已核对 [v2.1.0 上游 license](https://github.com/fabiospampinato/khroma/blob/v2.1.0/license) 为 MIT，版权为 `2019-present Fabio Spampinato, Andrew Maney`。后续分发前端编译产物时需一并核查其依赖声明和各许可要求。

AI 生成的学习内容和插画默认保存在用户本机数据库，不是本源码仓库的一部分。导出、分享或另行分发时，应核查模型服务条款和内容所涉及材料的权利。
