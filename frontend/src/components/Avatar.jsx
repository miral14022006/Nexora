import { initials } from "../format.js";

const COLORS = [
  "bg-indigo-500",
  "bg-emerald-500",
  "bg-rose-500",
  "bg-amber-500",
  "bg-sky-500",
  "bg-fuchsia-500",
  "bg-teal-500",
  "bg-orange-500",
];

function colorFor(id) {
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) % 997;
  return COLORS[h % COLORS.length];
}

export default function Avatar({ id, name, size = "md", online = null }) {
  const sizes = {
    sm: "h-8 w-8 text-xs",
    md: "h-10 w-10 text-sm",
    lg: "h-12 w-12 text-base",
  };
  return (
    <div className="relative shrink-0">
      <div
        className={`${sizes[size]} ${colorFor(id)} nm-raised-sm flex items-center justify-center rounded-full font-bold text-white`}
      >
        {initials(name)}
      </div>
      {online !== null && (
        <span
          title={online ? "Online" : "Offline"}
          className={`absolute -bottom-0.5 -right-0.5 block h-3 w-3 rounded-full`}
          style={{
            borderWidth: 2,
            borderStyle: "solid",
            borderColor: "var(--nm-bg)",
            backgroundColor: online ? "var(--nm-success)" : "var(--nm-text-faint)",
          }}
        />
      )}
    </div>
  );
}
