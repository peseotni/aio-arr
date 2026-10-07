import clsx from 'clsx';
import { LoaderCircle } from 'lucide-react';
import { forwardRef, type ButtonHTMLAttributes, type ComponentType, type ReactNode, type SelectHTMLAttributes } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success' | 'outline';
type Size = 'xs' | 'sm' | 'md' | 'lg';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-accent-fg hover:bg-accent-strong shadow-sm shadow-accent/20',
  secondary: 'bg-card-hover text-fg hover:bg-line-strong/60 border border-line',
  outline: 'border border-line-strong text-fg hover:bg-card-hover',
  ghost: 'text-muted hover:text-fg hover:bg-card-hover',
  danger: 'bg-bad/12 text-bad hover:bg-bad/20 border border-bad/25',
  success: 'bg-ok/15 text-ok hover:bg-ok/25 border border-ok/25',
};

const SIZES: Record<Size, string> = {
  xs: 'h-7 px-2.5 text-xs gap-1.5 rounded-lg',
  sm: 'h-8 px-3 text-[13px] gap-1.5 rounded-lg',
  md: 'h-10 px-4 text-sm gap-2 rounded-xl',
  lg: 'h-12 px-5 text-[15px] gap-2.5 rounded-xl',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ComponentType<{ className?: string }>;
  iconRight?: ComponentType<{ className?: string }>;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, icon: Icon, iconRight: IconRight, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  const iconSize = size === 'xs' ? 'size-3.5' : size === 'lg' ? 'size-5' : 'size-4';
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={clsx(
        'inline-flex shrink-0 select-none items-center justify-center font-medium whitespace-nowrap transition-all duration-150 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {loading ? <LoaderCircle className={clsx(iconSize, 'animate-spin')} /> : Icon ? <Icon className={iconSize} /> : null}
      {children}
      {IconRight && !loading ? <IconRight className={iconSize} /> : null}
    </button>
  );
});

export function IconButton({
  icon: Icon,
  label,
  className,
  size = 'md',
  variant = 'ghost',
  loading,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { icon: ComponentType<{ className?: string }>; label: string; size?: 'sm' | 'md'; variant?: Variant; loading?: boolean }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={rest.disabled || loading}
      className={clsx(
        'inline-flex shrink-0 items-center justify-center rounded-lg transition-colors disabled:pointer-events-none disabled:opacity-40',
        size === 'sm' ? 'size-7' : 'size-9',
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {loading ? <LoaderCircle className="size-4 animate-spin" /> : <Icon className={size === 'sm' ? 'size-3.5' : 'size-[18px]'} />}
    </button>
  );
}

export type Tone = 'neutral' | 'accent' | 'ok' | 'warn' | 'bad' | 'info';

const TONES: Record<Tone, string> = {
  neutral: 'bg-fg/[0.07] text-muted border-fg/10',
  accent: 'bg-accent/15 text-accent border-accent/25',
  ok: 'bg-ok/15 text-ok border-ok/25',
  warn: 'bg-warn/15 text-warn border-warn/25',
  bad: 'bg-bad/15 text-bad border-bad/25',
  info: 'bg-info/15 text-info border-info/25',
};

export function Badge({ tone = 'neutral', children, className, icon: Icon }: { tone?: Tone; children: ReactNode; className?: string; icon?: ComponentType<{ className?: string }> }) {
  return (
    <span className={clsx('inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-semibold leading-none whitespace-nowrap', TONES[tone], className)}>
      {Icon && <Icon className="size-3" />}
      {children}
    </span>
  );
}

export function Dot({ tone = 'neutral', pulse }: { tone?: Tone; pulse?: boolean }) {
  const color = { neutral: 'bg-subtle', accent: 'bg-accent', ok: 'bg-ok', warn: 'bg-warn', bad: 'bg-bad', info: 'bg-info' }[tone];
  return (
    <span className="relative inline-flex size-2 shrink-0">
      {pulse && <span className={clsx('absolute inline-flex size-full animate-ping rounded-full opacity-60', color)} />}
      <span className={clsx('relative inline-flex size-2 rounded-full', color)} />
    </span>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <LoaderCircle className={clsx('animate-spin text-muted', className || 'size-5')} />;
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx('skeleton rounded-xl', className)} />;
}

export function Progress({ value, tone = 'accent', active, className }: { value: number; tone?: Tone; active?: boolean; className?: string }) {
  const color = { neutral: 'bg-subtle', accent: 'bg-accent', ok: 'bg-ok', warn: 'bg-warn', bad: 'bg-bad', info: 'bg-info' }[tone];
  return (
    <div className={clsx('h-1.5 w-full overflow-hidden rounded-full bg-fg/[0.08]', className)}>
      <div
        className={clsx('h-full rounded-full transition-[width] duration-700 ease-out', color, active && 'progress-stripes')}
        style={{ width: `${Math.max(0, Math.min(100, value * 100))}%` }}
      />
    </div>
  );
}

export function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx(
        'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors disabled:opacity-50',
        checked ? 'border-accent bg-accent' : 'border-line-strong bg-fg/10',
      )}
    >
      <span className={clsx('inline-block size-[18px] rounded-full bg-white shadow transition-transform', checked ? 'translate-x-[22px]' : 'translate-x-[2px]')} />
    </button>
  );
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={clsx('input appearance-none bg-[length:14px] bg-[right_10px_center] bg-no-repeat pr-8', className)} style={{ backgroundImage: 'var(--chevron)' }} {...rest}>
      {children}
    </select>
  );
}

export function Tabs<T extends string>({
  value,
  onChange,
  items,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  items: { value: T; label: ReactNode; count?: number; icon?: ComponentType<{ className?: string }> }[];
  className?: string;
}) {
  return (
    <div className={clsx('no-scrollbar inline-flex max-w-full gap-1 overflow-x-auto rounded-xl border border-line bg-inset p-1', className)}>
      {items.map((it) => (
        <button
          key={it.value}
          type="button"
          onClick={() => onChange(it.value)}
          className={clsx(
            'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-3 text-[13px] font-medium transition-colors',
            value === it.value ? 'bg-card text-fg shadow-sm ring-1 ring-line' : 'text-muted hover:text-fg',
          )}
        >
          {it.icon && <it.icon className="size-4" />}
          {it.label}
          {it.count !== undefined && <span className={clsx('rounded-md px-1.5 text-[11px] tabular-nums', value === it.value ? 'bg-accent/15 text-accent' : 'bg-fg/[0.06]')}>{it.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  children,
  action,
  className,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={clsx('flex flex-col items-center justify-center rounded-2xl border border-dashed border-line px-6 py-14 text-center', className)}>
      <div className="mb-4 grid size-12 place-items-center rounded-2xl bg-accent/10 text-accent">
        <Icon className="size-6" />
      </div>
      <h3 className="text-base font-semibold">{title}</h3>
      {children && <div className="mt-1.5 max-w-md text-sm text-muted">{children}</div>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function SectionHeader({ title, subtitle, action, icon: Icon }: { title: ReactNode; subtitle?: ReactNode; action?: ReactNode; icon?: ComponentType<{ className?: string }> }) {
  return (
    <div className="mb-3 flex items-end justify-between gap-3">
      <div className="min-w-0">
        <h2 className="flex items-center gap-2 text-[15px] font-semibold tracking-tight">
          {Icon && <Icon className="size-4 text-accent" />}
          {title}
        </h2>
        {subtitle && <p className="mt-0.5 truncate text-xs text-muted">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions, icon: Icon }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; icon?: ComponentType<{ className?: string }> }) {
  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
      <div className="flex min-w-0 items-center gap-3">
        {Icon && (
          <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent/12 text-accent ring-1 ring-accent/20">
            <Icon className="size-5" />
          </div>
        )}
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold tracking-tight sm:text-2xl">{title}</h1>
          {subtitle && <p className="mt-0.5 text-sm text-muted">{subtitle}</p>}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded-md border border-line-strong bg-card px-1.5 py-0.5 font-sans text-[10px] font-semibold text-muted">{children}</kbd>;
}

export function ErrorNote({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={clsx('rounded-xl border border-bad/25 bg-bad/10 px-3.5 py-2.5 text-sm text-bad', className)}>{children}</div>;
}

export function InfoNote({ children, className, tone = 'info' }: { children: ReactNode; className?: string; tone?: 'info' | 'warn' }) {
  return (
    <div className={clsx('rounded-xl border px-3.5 py-2.5 text-sm', tone === 'warn' ? 'border-warn/25 bg-warn/10 text-warn' : 'border-info/25 bg-info/10 text-info', className)}>
      {children}
    </div>
  );
}

export function Field({ label, hint, children, className }: { label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={clsx('block', className)}>
      <span className="label">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-subtle">{hint}</span>}
    </label>
  );
}

export function StatCard({ icon: Icon, label, value, sub, tone = 'accent', onClick }: { icon: ComponentType<{ className?: string }>; label: string; value: ReactNode; sub?: ReactNode; tone?: Tone; onClick?: () => void }) {
  const toneBg = { neutral: 'bg-fg/10 text-muted', accent: 'bg-accent/12 text-accent', ok: 'bg-ok/12 text-ok', warn: 'bg-warn/12 text-warn', bad: 'bg-bad/12 text-bad', info: 'bg-info/12 text-info' }[tone];
  const Comp = onClick ? 'button' : 'div';
  return (
    <Comp onClick={onClick} className={clsx('card flex items-center gap-3 p-3.5 text-left', onClick && 'transition-colors hover:bg-card-hover')}>
      <div className={clsx('grid size-10 shrink-0 place-items-center rounded-xl', toneBg)}>
        <Icon className="size-5" />
      </div>
      <div className="min-w-0">
        <div className="text-[11px] font-medium tracking-wide text-muted uppercase">{label}</div>
        <div className="truncate text-lg leading-tight font-semibold tabular-nums">{value}</div>
        {sub && <div className="truncate text-xs text-subtle">{sub}</div>}
      </div>
    </Comp>
  );
}
