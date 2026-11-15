/** Pixel cat typing on a keyboard. Pure SVG + CSS; animation is disabled under reduced motion. */
export function TypingCat({ label }: { label: string }) {
  return (
    <div className="cat-wrap" role="status" aria-live="polite">
      <svg className="cat" viewBox="0 0 32 24" width="160" height="120" shapeRendering="crispEdges" aria-hidden="true">
        {/* ears + head */}
        <path className="cat-fill" d="M9 3h3v3h8V3h3v3h1v9H8V6h1z" />
        <path className="cat-stroke" d="M9 3h3v1h-3zM20 3h3v1h-3zM8 6h1v9H8zM23 6h1v9h-1zM9 15h14v1H9z" />
        {/* eyes + nose */}
        <rect className="cat-ink cat-blink" x="12" y="9" width="2" height="3" />
        <rect className="cat-ink cat-blink" x="18" y="9" width="2" height="3" />
        <rect className="cat-accent" x="15" y="12" width="2" height="1" />
        {/* paws */}
        <rect className="cat-fill cat-paw cat-paw-l" x="10" y="16" width="4" height="3" />
        <rect className="cat-fill cat-paw cat-paw-r" x="18" y="16" width="4" height="3" />
        <path className="cat-stroke cat-paw cat-paw-l" d="M10 19h4v-1h-4z" />
        <path className="cat-stroke cat-paw cat-paw-r" d="M18 19h4v-1h-4z" />
        {/* keyboard */}
        <rect className="cat-ink" x="4" y="19" width="24" height="5" />
        {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
          <rect key={i} className={`cat-key cat-key-${i % 4}`} x={5 + i * 3} y="20" width="2" height="1" />
        ))}
        {[0, 1, 2, 3, 4, 5, 6].map((i) => (
          <rect key={i} className={`cat-key cat-key-${(i + 2) % 4}`} x={6 + i * 3} y="22" width="2" height="1" />
        ))}
      </svg>
      <div className="cat-label">
        {label}
        <span className="cat-dots" aria-hidden="true" />
      </div>
    </div>
  );
}
