import { type ReactNode, type SyntheticEvent, useState } from 'react';

/** Logos from the catalog's image host can be read back (it allows any origin); others are left alone. */
const READABLE = /^https:\/\/images\.metahub\.space\//;

/**
 * Whether a logo is mostly dark (black lettering, say), which would vanish on a dark backdrop. Only its
 * drawn pixels count, and a tainted or blank canvas says no.
 */
function isDark(image: HTMLImageElement): boolean {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 24;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return false;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let sum = 0;
    let count = 0;
    for (let index = 0; index < data.length; index += 4) {
      if (data[index + 3]! < 128) continue;
      sum += (0.2126 * data[index]! + 0.7152 * data[index + 1]! + 0.0722 * data[index + 2]!) / 255;
      count += 1;
    }
    return count > 40 && sum / count < 0.28;
  } catch {
    return false;
  }
}

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
  const [darkLogo, setDarkLogo] = useState(false);
  // Some logos come through a redirect without the header that allows reading them: those load plainly.
  const [plainLogo, setPlainLogo] = useState(false);
  const readable = Boolean(logo && READABLE.test(logo)) && !plainLogo;
  const [noBackdrop, setNoBackdrop] = useState(false);
  return (
    <section className={`hero ${size}`}>
      {background && !noBackdrop && <img className="hero-backdrop" src={background} alt="" fetchPriority="high" decoding="async" onError={() => setNoBackdrop(true)} />}
      <div className="hero-scrim" aria-hidden="true" />
      <div className="hero-content">
        {logo && !noLogo
          ? (
            <h1 className={`hero-logo ${darkLogo ? 'dark' : ''}`}>
              <img
                key={readable ? 'read' : 'plain'}
                src={logo}
                alt={title}
                crossOrigin={readable ? 'anonymous' : undefined}
                onError={() => (readable ? setPlainLogo(true) : setNoLogo(true))}
                onLoad={readable ? (event: SyntheticEvent<HTMLImageElement>) => setDarkLogo(isDark(event.currentTarget)) : undefined}
              />
            </h1>
          )
          : <h1 className="hero-title">{title}</h1>}
        {facts && <div className="hero-facts">{facts}</div>}
        {description && <p className="hero-description">{description}</p>}
        {children && <div className="hero-actions">{children}</div>}
        {footer}
      </div>
    </section>
  );
}
