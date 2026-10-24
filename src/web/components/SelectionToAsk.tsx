import { useEffect, useState } from 'react';

/** 选中的内容太短时不提示，太长时截断 */
const MIN_LENGTH = 2;
const MAX_LENGTH = 2000;

/**
 * 在知识内容里选中一段文字后，选区上方浮出"引用到随时提问"；点一下把这段文字交给提问框。
 * scope 是可以选中的区域（CSS 选择器），提问框自身里的选中不提示。
 * onQuote 的第二个参数是选区所在的元素，调用方可据此找出它属于哪个知识点。
 */
export function SelectionToAsk({ scope, onQuote }: { scope: string; onQuote: (text: string, from: Element) => void }) {
  const [hint, setHint] = useState<{ x: number; y: number; below: boolean; text: string; from: Element } | null>(null);

  useEffect(() => {
    let timer: number | undefined;
    const update = () => {
      const selection = window.getSelection();
      const text = selection?.toString().trim() ?? '';
      if (!selection || selection.rangeCount === 0 || text.length < MIN_LENGTH) return setHint(null);
      const range = selection.getRangeAt(0);
      const node = range.commonAncestorContainer;
      const element = node instanceof Element ? node : node.parentElement;
      if (!element || !element.closest(scope) || element.closest('.ask-panel')) return setHint(null);
      const rect = range.getBoundingClientRect();
      const below = rect.top < 64;
      setHint({ x: rect.left + rect.width / 2, y: below ? rect.bottom : rect.top, below, text: text.slice(0, MAX_LENGTH), from: element });
    };
    // 鼠标松开、键盘选择、手机上长按选择都会触发 selectionchange；稍等选区稳定再判断
    const onChange = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(update, 250);
    };
    const hide = () => setHint(null);
    document.addEventListener('selectionchange', onChange);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('selectionchange', onChange);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
    };
  }, [scope]);

  if (!hint) return null;
  return (
    <button
      type="button"
      className={`selection-ask ${hint.below ? 'below' : ''}`}
      style={{ left: hint.x, top: hint.y }}
      // 按下时不让选区消失
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        onQuote(hint.text, hint.from);
        setHint(null);
        window.getSelection()?.removeAllRanges();
      }}
    >
      引用到随时提问
    </button>
  );
}
