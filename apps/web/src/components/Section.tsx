import type { ReactNode } from 'react';

/**
 * A titled section: icon tile, title and one-line purpose on the left, its actions on the right,
 * then a divider and the body. Every settings-style block uses this so they read the same way.
 */
export function Section({ icon, title, intro, actions, id, className = '', children }: {
  icon: ReactNode; title: ReactNode; intro?: ReactNode; actions?: ReactNode; id?: string; className?: string; children?: ReactNode;
}) {
  return <section className={'block ' + className} id={id}>
    <header className="block-head">
      <span className="block-icon" aria-hidden="true">{icon}</span>
      <div className="block-title">
        <h2>{title}</h2>
        {intro && <p>{intro}</p>}
      </div>
      {actions && <div className="block-actions">{actions}</div>}
    </header>
    {children !== undefined && children !== null && children !== false && <div className="block-body">{children}</div>}
  </section>;
}
