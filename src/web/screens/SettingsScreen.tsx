import { AiSettings } from './AiSettings';

/** 常规设置：配置文本和画图所用的模型。 */
export function SettingsScreen() {
  return (
    <>
      <div className="title-row">
        <div>
          <h1>设置</h1>
          <p className="sub">配置生成内容所用的模型，修改后点击保存。</p>
        </div>
      </div>
      <AiSettings />
    </>
  );
}
