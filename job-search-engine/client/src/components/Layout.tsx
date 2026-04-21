import { NavLink } from "react-router-dom";
import type { ReactNode } from "react";

const NAV = [
  { to: "/search",      label: "Search",      icon: SearchIcon },
  { to: "/tracker",     label: "Tracker",     icon: KanbanIcon },
  { to: "/tune",        label: "Tune",        icon: TuneIcon },
  { to: "/observatory", label: "Observatory", icon: RadarIcon },
] as const;

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col min-h-screen bg-void">
      {/* Top nav */}
      <header className="border-b border-border-subtle bg-void/95 backdrop-blur-sm sticky top-0 z-40">
        <div className="max-w-screen-xl mx-auto px-6 h-12 flex items-center gap-6">
          {/* Logo */}
          <span className="text-sm font-semibold text-zinc-100 tracking-tight select-none">
            Orpheus
          </span>
          <div className="w-px h-4 bg-border-default" />
          {/* Nav links */}
          <nav className="flex items-center gap-0.5">
            {NAV.map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                className={({ isActive }) =>
                  `flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm transition-colors duration-150 ${
                    isActive
                      ? "text-zinc-100 bg-elevated"
                      : "text-zinc-500 hover:text-zinc-300 hover:bg-elevated/50"
                  }`
                }
              >
                <Icon className="w-3.5 h-3.5" />
                {label}
              </NavLink>
            ))}
          </nav>
        </div>
      </header>

      {/* Page content */}
      <main className="flex-1">{children}</main>
    </div>
  );
}

// ─── Inline icons ─────────────────────────────────────────────────

function SearchIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="6.5" cy="6.5" r="4" />
      <path d="M11 11l3 3" strokeLinecap="round" />
    </svg>
  );
}

function KanbanIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="1" y="2" width="4" height="9" rx="1" />
      <rect x="6" y="2" width="4" height="12" rx="1" />
      <rect x="11" y="2" width="4" height="6" rx="1" />
    </svg>
  );
}

function TuneIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M2 4h2m0 0a2 2 0 004 0m-4 0a2 2 0 014 0m0 0h6M2 8h6m0 0a2 2 0 004 0m-4 0a2 2 0 014 0m0 0h2M2 12h2m0 0a2 2 0 004 0m-4 0a2 2 0 014 0m0 0h6" strokeLinecap="round" />
    </svg>
  );
}

function RadarIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="8" cy="8" r="6" />
      <circle cx="8" cy="8" r="3" />
      <circle cx="8" cy="8" r="1" fill="currentColor" stroke="none" />
      <path d="M8 8 L13 3" strokeLinecap="round" />
    </svg>
  );
}
