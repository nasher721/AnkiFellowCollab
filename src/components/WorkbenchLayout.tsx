import { type ReactNode } from 'react';
import type { WorkbenchRailKind } from '../hooks/common';

export function WorkbenchLayout({
  railKind,
  rail,
  children
}: {
  railKind: WorkbenchRailKind;
  rail?: ReactNode;
  children: ReactNode;
}) {
  const hasRail = railKind !== 'none' && Boolean(rail);
  return (
    <div className={`content-grid content-grid--${hasRail ? 'with-rail' : 'full'} content-grid--rail-${railKind}`}>
      <section className="deck-panel">
        {children}
      </section>
      {hasRail ? (
        <aside className={`review-panel context-rail context-rail--${railKind}`} aria-label="Workbench context">
          {rail}
        </aside>
      ) : null}
    </div>
  );
}
