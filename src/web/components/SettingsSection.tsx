/** 一组设置：标题与说明在上，控件在下方使用完整宽度。 */
export function Section({ title, description, children }: { title: string; description: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="settings-section">
      <header className="settings-heading">
        <h2>{title}</h2>
        <p>{description}</p>
      </header>
      <div className="settings-content">{children}</div>
    </section>
  );
}
