import { useRef, useState } from 'react';

/**
 * Adapted from Watermelon UI's stats-4 block (a marketing landing-page hero
 * section originally — "Elevate your financial ops" fintech copy, "Start
 * building"/"View demo" CTAs). The mouse-follow glow border + icon-badge +
 * big bold metric pattern is genuinely good; stripped out the marketing
 * chrome (badge pill, CTA buttons, case-study copy) and made it a plain
 * data-driven card for real dashboard stats instead.
 */
export function GlowingBorderCard({
  children, className, glowColor, repeatingGradient,
}: {
  children: React.ReactNode;
  className?: string;
  glowColor: string;
  repeatingGradient: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [opacity, setOpacity] = useState(0);

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    setPosition({ x: e.clientX - rect.left, y: e.clientY - rect.top });
  };

  return (
    <div
      ref={ref}
      onMouseMove={handleMouseMove}
      onMouseEnter={() => setOpacity(1)}
      onMouseLeave={() => setOpacity(0)}
      className={`relative rounded-2xl bg-border/40 p-[2px] ${className || ''}`}
    >
      <div
        className="pointer-events-none absolute inset-0 rounded-2xl transition-opacity duration-300"
        style={{ opacity, background: `radial-gradient(300px circle at ${position.x}px ${position.y}px, ${glowColor}, transparent 40%)` }}
      />
      <div className="relative z-10 h-full overflow-hidden rounded-2xl bg-card">
        <div className="pointer-events-none absolute inset-0 opacity-30" style={{ background: repeatingGradient }} />
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-transparent to-card/80" />
        <div className="relative z-20 flex h-full flex-col justify-between p-5">{children}</div>
      </div>
    </div>
  );
}
