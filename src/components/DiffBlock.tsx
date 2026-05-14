export function DiffBlock({ label, before, after }: { label: string; before?: string; after?: string }) {
  return (
    <div className="diff-block">
      <label>{label}</label>
      <div className="diff-lines">
        <p className="removed">- {before || 'Empty'}</p>
        <p className="added">+ {after || before || 'No suggested change'}</p>
      </div>
    </div>
  );
}
