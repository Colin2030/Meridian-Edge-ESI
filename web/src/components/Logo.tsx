import iconCharcoal from '../assets/brand/meridian-icon.png';
import iconWhite from '../assets/brand/meridian-icon-white-transparent.png';
import lockupInverted from '../assets/brand/meridian-logo-horizontal-inverted-transparent.png';

// Icon mark only. On dark/charcoal surfaces pass `light` for the white icon;
// on light surfaces the charcoal icon is used as-is.
export function Logo({ size = 32, light = false }: { size?: number; light?: boolean }) {
  const src = light ? iconWhite : iconCharcoal;
  return (
    <img
      src={src}
      alt="Meridian Edge"
      width={size}
      height={size}
      className="object-contain select-none"
      style={{ width: size, height: size }}
      draggable={false}
    />
  );
}

// Full brand lockup with the "ESI Review Platform" descriptor sub-label.
// On dark surfaces the official white-on-charcoal horizontal lockup image is used
// (so the "Meridian Edge" wordmark is NOT duplicated as text). On light surfaces
// we compose the charcoal icon with the wordmark text (no light lockup asset exists).
export function Wordmark({ light = false, height = 30 }: { light?: boolean; height?: number }) {
  if (light) {
    return (
      <div className="select-none">
        <img
          src={lockupInverted}
          alt="Meridian Edge"
          style={{ height, width: 'auto' }}
          className="object-contain"
          draggable={false}
        />
        <div className="mt-1 pl-0.5 text-[9px] font-medium uppercase tracking-[0.22em] text-slate-400">
          ESI Review Platform
        </div>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2.5 select-none">
      <Logo size={height} />
      <div className="leading-none">
        <div className="text-[15px] font-bold tracking-tight text-navy-900">
          Meridian Edge
        </div>
        <div className="mt-1 text-[9px] font-medium uppercase tracking-[0.18em] text-slate-400">
          ESI Review Platform
        </div>
      </div>
    </div>
  );
}
