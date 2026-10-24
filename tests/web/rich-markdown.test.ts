import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RichMarkdown } from '../../src/web/RichMarkdown';

const render = (markdown: string) => renderToStaticMarkup(createElement(RichMarkdown, null, markdown));

/** AI 生成的讲解按写作原则会用表格、加粗、列表，这些都要渲染成真正的元素，而不是原样的符号 */
describe('讲解的 Markdown 渲染', () => {
  it('表格渲染为 table，表头与每一行各成一行', () => {
    const html = render('| 对比项 | 普通函数 | 箭头函数 |\n|---|---|---|\n| 参数 | 始终写 `()` | 单参数可省 `()` |\n| this | 由调用方式决定 | 取定义位置外层的 `this` |');
    expect(html).toContain('<table>');
    expect(html).toContain('<th>对比项</th>');
    expect(html.match(/<tr>/g)).toHaveLength(3);
    expect(html).not.toContain('|---|');
  });

  it('加粗、列表、删除线照常渲染', () => {
    const html = render('它**不绑定自己的 this**。\n\n- 第一条\n- 第二条\n\n~~旧写法~~');
    expect(html).toContain('<strong>不绑定自己的 this</strong>');
    expect(html.match(/<li>/g)).toHaveLength(2);
    expect(html).toContain('<del>旧写法</del>');
  });

  it('不渲染原始 HTML：AI 生成的内容不能注入脚本', () => {
    expect(render('<script>alert(1)</script>正文')).not.toContain('<script>');
  });

  it('illustration: 引用显示为插画（画好前是占位和图的说明），不会被链接过滤清空', () => {
    const html = render('看这张图：\n\n![箭头函数的 this 在定义时固定](illustration:abc-123)');
    expect(html).toContain('class="diagram illustration placeholder"');
    expect(html).toContain('正在生成图片');
    expect(html).toContain('箭头函数的 this 在定义时固定');
    // 插画放在段落里，不能用块级的 figure
    expect(html).not.toContain('<figure');
  });

  it('普通链接的危险协议照常被过滤', () => {
    expect(render('[点我](javascript:alert(1))')).not.toContain('javascript:');
  });

  it('AI 内容中的外部图片不自动加载，保留图片说明', () => {
    const html = render('![概念示意](https://attacker.invalid/track?answer=private)');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('attacker.invalid');
    expect(html).toContain('概念示意');
  });

  it('不把带路径或查询参数的插画引用交给接口加载', () => {
    for (const id of ['../settings', 'abc?token=private', 'abc%2f..']) {
      const html = render(`![图解](illustration:${id})`);
      expect(html).not.toContain('illustration placeholder');
      expect(html).toContain('图解');
    }
  });
});
