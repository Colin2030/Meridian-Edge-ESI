export function Logo({ size = 32, light = false }: { size?: number; light?: boolean }) {
  const mark = light ? '#c9a876' : '#b08d57';
  const body = light ? '#ffffff' : '#0f1b33';
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <rect x="3" y="3" width="42" height="42" rx="9" fill={body} />
      <path d="M12 33V15h4.4l7.6 11 7.6-11H36v18h-4.3V22.3L24.4 33h-0.8L16.3 22.3V33H12z" fill={mark} />
      <path d="M24 6l2.1 4.3 4.7.7-3.4 3.3.8 4.7-4.2-2.2-4.2 2.2.8-4.7-3.4-3.3 4.7-.7L24 6z" fill={mark} opacity="0" />
    </svg>
  );
}

export function Wordmark({ light = false }: { light?: boolean }) {
  return (
    <div className="flex items-center gap-2.5 select-none">
      <Logo size={30} light={light} />
      <div className="leading-none">
        <div className={`text-[15px] font-bold tracking-tight ${light ? 'text-white' : 'text-navy-900'}`}>
          Meridian <span className="text-accent">Edge</span>
        </div>
        <div className={`text-[9px] font-medium uppercase tracking-[0.18em] ${light ? 'text-slate-300' : 'text-slate-400'}`}>
          ESI Review Platform
        </div>
      </div>
    </div>
  );
}
