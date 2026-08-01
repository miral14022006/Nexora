/**
 * The Mesh — the landing hero's signature moment: messages routing between
 * people and fanning out through a group, drawn as one quiet SVG scene.
 * Under prefers-reduced-motion the packets freeze mid-route (static frame).
 * Colors adapt to light/dark mode via CSS custom properties.
 */
export default function HeroMesh() {
  const P = {
    you: "path('M 170 150 C 260 90, 330 90, 420 150')",
    fan: "path('M 470 430 C 380 470, 300 470, 210 430')",
    one: "path('M 470 430 C 420 340, 350 250, 230 250')",
    two: "path('M 470 430 C 430 480, 250 480, 200 400')",
    three: "path('M 470 430 C 470 500, 380 520, 300 480')",
  };

  const tick = { x: 442, y: 158 };

  return (
    <div
      aria-hidden="true"
      className="relative w-full max-w-[600px] select-none"
    >
      <svg
        viewBox="0 0 640 560"
        className="h-auto w-full"
        role="presentation"
      >
        <defs>
          <pattern id="mesh-grid" width="40" height="40" patternUnits="userSpaceOnUse">
            <path d="M 40 0 L 0 0 0 40" fill="none" stroke="var(--nm-mesh-grid)" strokeWidth="1" />
          </pattern>
          <filter id="packet-glow" x="-200%" y="-200%" width="500%" height="500%">
            <feGaussianBlur stdDeviation="4" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        <rect width="640" height="560" fill="url(#mesh-grid)" />

        {/* routing paths */}
        <g stroke="var(--nm-mesh-path)" strokeWidth="1.5" fill="none">
          <path d="M 170 150 C 260 90, 330 90, 420 150" />
          <path d="M 470 430 C 380 470, 300 470, 210 430" />
          <path d="M 470 430 C 420 340, 350 250, 230 250" />
          <path d="M 470 430 C 430 480, 250 480, 200 400" />
          <path d="M 470 430 C 470 500, 380 520, 300 480" />
        </g>

        {/* person nodes */}
        {[
          { cx: 170, cy: 150, label: "you" },
          { cx: 420, cy: 150, label: "they" },
          { cx: 210, cy: 430, label: "maya" },
          { cx: 200, cy: 400, label: "sam" },
          { cx: 300, cy: 480, label: "group · 3 online" },
        ].map((n) => (
          <g key={n.label}>
            <circle cx={n.cx} cy={n.cy} r="26" fill="var(--nm-mesh-node)" stroke="var(--nm-mesh-node-stroke)" strokeWidth="1.5" />
            <circle cx={n.cx} cy={n.cy} r="4" fill="var(--nm-success)" className="mesh-dot" />
            <text
              x={n.cx}
              y={n.cy + 46}
              textAnchor="middle"
              fill="var(--nm-mesh-label)"
              style={{ font: "600 13px ui-monospace, Menlo, monospace", letterSpacing: "0.08em" }}
            >
              {n.label}
            </text>
          </g>
        ))}

        {/* group hub */}
        <g>
          <rect x="428" y="388" width="84" height="84" rx="16" fill="var(--nm-mesh-node)" stroke="var(--nm-mesh-node-stroke)" strokeWidth="1.5" />
          <circle cx="470" cy="430" r="4" fill="var(--nm-error)" className="mesh-dot" style={{ animationDelay: "0.6s" }} />
          <text
            x="470"
            y="506"
            textAnchor="middle"
            fill="var(--nm-mesh-label)"
            style={{ font: "600 13px ui-monospace, Menlo, monospace", letterSpacing: "0.08em" }}
          >
            the hub
          </text>
        </g>

        {/* direct-message packet: you → they */}
        <circle
          r="7"
          fill="var(--nm-success)"
          filter="url(#packet-glow)"
          className="mesh-packet"
          style={{ "--path": P.you }}
        />

        {/* fan-out: hub → maya / sam / group */}
        {[P.fan, P.one, P.two].map((p, i) => (
          <circle
            key={i}
            r="6"
            fill="var(--nm-error)"
            className="mesh-fanout"
            style={{ "--path": p, animationDelay: `${i * 0.7}s` }}
          />
        ))}

        {/* delivery tick at destination */}
        <g className="mesh-tick" style={{ animationDelay: "3.9s" }} transform={`translate(${tick.x} ${tick.y})`}>
          <rect x="-12" y="-9" width="24" height="18" rx="4" fill="var(--nm-mesh-node)" stroke="var(--nm-mesh-node-stroke)" strokeWidth="1" />
          <text
            x="0"
            y="4"
            textAnchor="middle"
            fill="var(--nm-error)"
            style={{ font: "700 11px ui-monospace, Menlo, monospace" }}
          >
            ✓✓
          </text>
        </g>
      </svg>

      <p className="mt-2 text-center font-mono text-[11px] tracking-[0.2em] uppercase" style={{ color: "var(--nm-text-muted)" }}>
        direct messages · group fan-out · live presence
      </p>
    </div>
  );
}
