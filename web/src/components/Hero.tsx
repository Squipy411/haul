import { type ReactNode, useState } from 'react';

/** A full-width backdrop with the title's logo (or its name), a line of facts, a description and actions. */
export function Hero({ background, logo, title, facts, description, children, footer, size = 'large' }: {
  background?: string;
  logo?: string;
  title: string;
  facts?: ReactNode;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
  size?: 'large' | 'medium';
}) {
  const [noLogo, setNoLogo] = useState(false);
  const [noBackdrop, setNoBackdrop] = useState(false);
  return (
    <section className={`hero ${size}`}>
      {background && !noBackdrop && <img className="hero-backdrop" src={background} alt="" fetchPriority="high" decoding="async" onError={() => setNoBackdrop(true)} />}
      <div className="hero-scrim" aria-hidden="true" />
      <div className="hero-content">
        {logo && !noLogo
          ? <h1 className="hero-logo"><img src={logo} alt={title} onError={() => setNoLogo(true)} /></h1>
          : <h1 className="hero-title">{title}</h1>}
        {facts && <div className="hero-facts">{facts}</div>}
        {description && <p className="hero-description">{description}</p>}
        {children && <div className="hero-actions">{children}</div>}
        {footer}
      </div>
    </section>
  );
}
