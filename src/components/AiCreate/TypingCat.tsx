/**
 * Pixel cat. "typing": paws tap the keyboard while the AI works. "waiting": the AI is done and the cat
 * looks around with a bobbing "?" until the user accepts or discards. Pure SVG + CSS; motion is switched
 * off by Settings → Motion and by the OS reduce-motion setting (the "?" then just stays visible).
 */
export type CatMood = "typing" | "waiting";

// A bold 5x7 pixel question mark, drawn as rectangles (x, y, w) per row.
const QUESTION: [number, number, number][] = [
  [1, 0, 3], [0, 1, 2], [3, 1, 2], [3, 2, 2], [2, 3, 2], [2, 4, 1], [2, 6, 1],
];

export function TypingCat({ label, mood = "typing" }: { label: string; mood?: CatMood }) {
  const waiting = mood === "waiting";
  return (
    <div className="cat-wrap" role="status" aria-live="polite">
      <svg
        className={waiting ? "cat waiting" : "cat"}
        viewBox="0 -8 32 32"
        width="144"
        height="144"
        shapeRendering="crispEdges"
        aria-hidden="true"
      >
        {/* ears + head */}
        <path className="cat-fill" d="M9 3h3v3h8V3h3v3h1v9H8V6h1z" />
        <path className="cat-stroke" d="M9 3h3v1h-3zM20 3h3v1h-3zM8 6h1v9H8zM23 6h1v9h-1zM9 15h14v1H9z" />
        {/* eyes + nose */}
        <g className="cat-eyes">
          <rect className="cat-ink cat-blink" x="12" y="9" width="2" height="3" />
          <rect className="cat-ink cat-blink" x="18" y="9" width="2" height="3" />
        </g>
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
        {/* waiting: question mark above the head */}
        {waiting && (
          <g className="cat-q" data-testid="cat-question">
            {QUESTION.map(([x, y, w], i) => (
              <rect key={i} x={24 + x} y={-7 + y} width={w} height="1" />
            ))}
          </g>
        )}
      </svg>
      <div className="cat-label">
        {label}
        {!waiting && <span className="cat-dots" aria-hidden="true" />}
      </div>
    </div>
  );
}
