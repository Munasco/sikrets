const consumers = [
  { kind: "agent", name: "research-agent" },
  { kind: "app", name: "checkout-api" },
  { kind: "mcp server", name: "github-mcp" },
  { kind: "pipeline", name: "nightly-etl" },
]

const services = ["OpenAI", "Stripe", "AWS", "Postgres"]

const ROW_Y = [20, 100, 180, 260]
const ROW_H = 48
const HUB = { x: 370, y: 100, w: 220, h: 128 }

export function HeroDiagram() {
  return (
    <>
      <div className="hidden md:block">
        <WideDiagram />
      </div>
      <div className="md:hidden">
        <StackedDiagram />
      </div>
    </>
  )
}

// Phone layout: the same flow, top to bottom.
function StackedDiagram() {
  return (
    <div className="flex flex-col items-center text-left">
      <div className="grid w-full grid-cols-2 gap-2">
        {consumers.map((c) => (
          <div key={c.name} className="border border-line bg-surface px-3 py-2">
            <p className="font-mono text-[10px] text-faint">{c.kind}</p>
            <p className="font-mono text-xs text-text truncate">{c.name}</p>
          </div>
        ))}
      </div>
      <div className="h-8 border-l border-dashed border-line-strong" />
      <div className="w-full border-[1.7px] border-sage bg-field px-4 py-4 text-center">
        <p className="text-lg text-text">Sikrets</p>
        <p className="font-mono text-[11px] text-muted">keeps · scopes · rotates</p>
      </div>
      <div className="h-8 border-l border-dashed border-line-strong" />
      <div className="grid w-full grid-cols-2 gap-2">
        {services.map((s) => (
          <div key={s} className="border border-line bg-surface px-3 py-2.5 text-sm text-text">
            {s}
          </div>
        ))}
      </div>
    </div>
  )
}

// Consumers on the left get scoped access through Sikrets to the services on the right.
function WideDiagram() {
  const hubMidY = HUB.y + HUB.h / 2
  return (
    <svg viewBox="0 0 960 330" className="w-full h-auto" role="img" aria-label="Agents, apps, MCP servers and pipelines reach OpenAI, Stripe, AWS and Postgres through Sikrets, which keeps the keys and rotates them.">
      {ROW_Y.map((y) => (
        <g key={y} className="stroke-line-strong" fill="none" strokeWidth="1.5">
          <path className="flow" d={`M240 ${y + ROW_H / 2} C 305 ${y + ROW_H / 2}, 305 ${hubMidY}, ${HUB.x} ${hubMidY}`} />
          <path className="flow" d={`M${HUB.x + HUB.w} ${hubMidY} C 655 ${hubMidY}, 655 ${y + ROW_H / 2}, 720 ${y + ROW_H / 2}`} />
        </g>
      ))}

      {consumers.map((c, i) => (
        <g key={c.name} transform={`translate(20 ${ROW_Y[i]})`}>
          <rect width="220" height={ROW_H} className="fill-surface stroke-line" strokeWidth="1.5" />
          <text x="16" y="20" className="fill-faint font-mono" fontSize="11">{c.kind}</text>
          <text x="16" y="37" className="fill-text font-mono" fontSize="14">{c.name}</text>
        </g>
      ))}

      <g transform={`translate(${HUB.x} ${HUB.y})`}>
        <rect width={HUB.w} height={HUB.h} className="fill-field stroke-sage" strokeWidth="1.7" />
        <text x={HUB.w / 2} y="52" textAnchor="middle" className="fill-text" fontSize="22">Sikrets</text>
        <text x={HUB.w / 2} y="78" textAnchor="middle" className="fill-muted font-mono" fontSize="12">keeps · scopes · rotates</text>
        <g transform={`translate(${HUB.w / 2 - 8} 92)`} className="stroke-sage" fill="none" strokeWidth="1.5">
          <g className="spin">
            <path d="M14 8a6 6 0 1 1-2-4.5" />
            <path d="M12.5 0.5v3.5h-3.5" />
          </g>
        </g>
      </g>

      {services.map((s, i) => (
        <g key={s} transform={`translate(720 ${ROW_Y[i]})`}>
          <rect width="220" height={ROW_H} className="fill-surface stroke-line" strokeWidth="1.5" />
          <text x="16" y="30" className="fill-text" fontSize="15">{s}</text>
        </g>
      ))}
    </svg>
  )
}
