import clsx from 'clsx';
import {
  Activity,
  ArrowDown,
  ArrowUp,
  BookOpen,
  CalendarDays,
  Download,
  ExternalLink,
  Film,
  FolderOpen,
  House,
  Inbox,
  KeyRound,
  LogOut,
  Menu,
  Monitor,
  MonitorPlay,
  Moon,
  Music,
  Search,
  Settings,
  Sun,
  Tv,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState, type ComponentType, type FormEvent, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, errorMessage } from '../lib/api';
import { speed } from '../lib/format';
import { useApp, useDownloads, useStatus } from '../lib/queries';
import { Link, useRouter } from '../lib/router';
import { useTheme, type ThemeMode } from '../lib/theme';
import { Modal, useToast } from './overlay';
import { Button, Dot, Field, Kbd } from './ui';

interface NavItem {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  show?: boolean;
  badge?: number;
}

function Logo({ title }: { title: string }) {
  return (
    <Link to="/" className="flex items-center gap-2.5 px-2">
      <img src="/favicon.svg" alt="" className="size-8 rounded-[10px] shadow-lg shadow-accent/30" />
      <div className="leading-tight">
        <div className="text-[15px] font-bold tracking-tight">{title}</div>
        <div className="text-[10px] font-medium tracking-[0.14em] text-subtle uppercase">Media control</div>
      </div>
    </Link>
  );
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { path } = useRouter();
  const { data: app } = useApp();
  const { data: dl } = useDownloads();
  const { data: status } = useStatus();
  const svc = app?.services || {};
  const active = dl?.totals.active || 0;

  const groups: { title: string; items: NavItem[] }[] = [
    {
      title: 'Overview',
      items: [
        { to: '/', label: 'Home', icon: House },
        { to: '/search', label: 'Search', icon: Search },
        { to: '/downloads', label: 'Downloads', icon: Download, badge: active },
        { to: '/calendar', label: 'Calendar', icon: CalendarDays, show: !!(svc.sonarr?.enabled || svc.radarr?.enabled || svc.lidarr?.enabled) },
      ],
    },
    {
      title: 'Library',
      items: [
        { to: '/movies', label: 'Movies', icon: Film, show: !!svc.radarr?.enabled },
        { to: '/tv', label: 'TV Shows', icon: Tv, show: !!svc.sonarr?.enabled },
        { to: '/music', label: 'Music', icon: Music, show: !!svc.lidarr?.enabled },
        { to: '/books', label: 'Books', icon: BookOpen, show: !!svc.readarr?.enabled },
      ],
    },
    {
      title: 'Manage',
      items: [
        { to: '/wanted', label: 'Wanted', icon: Inbox, show: !!(svc.sonarr?.enabled || svc.radarr?.enabled || svc.lidarr?.enabled || svc.readarr?.enabled) },
        { to: '/files', label: 'Files', icon: FolderOpen },
        { to: '/system', label: 'System', icon: Activity },
        { to: '/settings', label: 'Settings', icon: Settings, show: app?.user.role === 'admin' },
      ],
    },
  ];

  const isActive = (to: string) => (to === '/' ? path === '/' : path === to || path.startsWith(`${to}/`));
  const apps = (status?.services || []).filter((s) => s.enabled);

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-16 items-center px-3">
        <Logo title={app?.title || 'AIO Arr'} />
      </div>
      <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-2">
        {groups.map((g) => {
          const items = g.items.filter((i) => i.show !== false);
          if (!items.length) return null;
          return (
            <div key={g.title}>
              <div className="mb-1.5 px-3 text-[10px] font-semibold tracking-[0.14em] text-subtle uppercase">{g.title}</div>
              <div className="space-y-0.5">
                {items.map((it) => (
                  <Link
                    key={it.to}
                    to={it.to}
                    onClick={onNavigate}
                    className={clsx(
                      'group flex h-9 items-center gap-3 rounded-lg px-3 text-[13.5px] font-medium transition-colors',
                      isActive(it.to) ? 'bg-accent/12 text-fg ring-1 ring-accent/20' : 'text-muted hover:bg-card-hover hover:text-fg',
                    )}
                  >
                    <it.icon className={clsx('size-[18px]', isActive(it.to) ? 'text-accent' : 'text-subtle group-hover:text-muted')} />
                    <span className="flex-1">{it.label}</span>
                    {it.badge ? <span className="rounded-md bg-accent px-1.5 py-0.5 text-[10px] font-bold text-white tabular-nums">{it.badge}</span> : null}
                  </Link>
                ))}
              </div>
            </div>
          );
        })}
        {apps.length > 0 && (
          <div>
            <div className="mb-1.5 px-3 text-[10px] font-semibold tracking-[0.14em] text-subtle uppercase">Apps</div>
            <div className="space-y-0.5">
              {apps.map((s) => (
                <a
                  key={s.id}
                  href={s.publicUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="group flex h-8 items-center gap-3 rounded-lg px-3 text-[13px] text-muted transition-colors hover:bg-card-hover hover:text-fg"
                  title={s.error || `${s.name} ${s.version || ''}`}
                >
                  <Dot tone={!s.online ? 'bad' : s.health.some((h) => h.type === 'error') ? 'bad' : s.health.some((h) => h.type === 'warning') ? 'warn' : 'ok'} />
                  <span className="flex-1 truncate">{s.name}</span>
                  <ExternalLink className="size-3.5 opacity-0 transition-opacity group-hover:opacity-100" />
                </a>
              ))}
            </div>
          </div>
        )}
      </nav>
      {app?.jellyfin && (
        <div className="p-3">
          <a
            href={app.jellyfin.publicUrl}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-3 rounded-xl bg-gradient-to-br from-[#aa5cc3] to-[#00a4dc] p-3 text-white shadow-lg transition-transform hover:scale-[1.02]"
          >
            <MonitorPlay className="size-5" />
            <div className="leading-tight">
              <div className="text-sm font-semibold">Open Jellyfin</div>
              <div className="text-[11px] text-white/80">Watch & listen</div>
            </div>
          </a>
        </div>
      )}
    </div>
  );
}

function SearchBox() {
  const { navigate, path, search } = useRouter();
  const [value, setValue] = useState(path === '/search' ? search.get('q') || '' : '');
  const ref = useRef<HTMLInputElement>(null);
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 640px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 640px)');
    const on = () => setNarrow(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  useEffect(() => {
    if (path === '/search') setValue(search.get('q') || '');
  }, [path, search]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const typing = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
      if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !typing)) {
        e.preventDefault();
        ref.current?.focus();
        ref.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const q = value.trim();
    if (q) navigate(`/search?q=${encodeURIComponent(q)}${search.get('tab') && path === '/search' ? `&tab=${search.get('tab')}` : ''}`);
    ref.current?.blur();
  };
  return (
    <form onSubmit={submit} className="relative w-full max-w-xl">
      <Search className="pointer-events-none absolute top-1/2 left-3.5 size-[18px] -translate-y-1/2 text-subtle" />
      <input
        ref={ref}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={narrow ? 'Search everything…' : 'Search movies, shows, music, books, anything…'}
        className="h-11 w-full rounded-xl border border-line bg-inset pr-16 pl-11 text-sm text-fg shadow-inner outline-none placeholder:text-subtle focus:border-accent focus:ring-2 focus:ring-accent/25"
        aria-label="Search"
        enterKeyHint="search"
      />
      <div className="pointer-events-none absolute top-1/2 right-3 hidden -translate-y-1/2 items-center gap-1 sm:flex">
        <Kbd>{navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}</Kbd>
        <Kbd>K</Kbd>
      </div>
    </form>
  );
}

function SpeedPill() {
  const { data } = useDownloads();
  if (!data || !data.clients.length) return null;
  return (
    <Link
      to="/downloads"
      className="hidden h-9 items-center gap-3 rounded-xl border border-line bg-inset px-3 text-xs font-semibold tabular-nums text-muted transition-colors hover:text-fg lg:flex"
      title="Total transfer speed"
    >
      <span className="flex items-center gap-1">
        <ArrowDown className={clsx('size-3.5', data.totals.downloadSpeed > 0 ? 'text-ok' : 'text-subtle')} />
        {speed(data.totals.downloadSpeed)}
      </span>
      <span className="flex items-center gap-1">
        <ArrowUp className={clsx('size-3.5', data.totals.uploadSpeed > 0 ? 'text-info' : 'text-subtle')} />
        {speed(data.totals.uploadSpeed)}
      </span>
    </Link>
  );
}

function ThemeButton() {
  const { mode, setMode } = useTheme();
  const next: Record<ThemeMode, ThemeMode> = { dark: 'light', light: 'system', system: 'dark' };
  const Icon = mode === 'dark' ? Moon : mode === 'light' ? Sun : Monitor;
  return (
    <button
      type="button"
      onClick={() => setMode(next[mode])}
      className="grid size-9 place-items-center rounded-xl border border-line bg-inset text-muted transition-colors hover:text-fg"
      title={`Theme: ${mode}`}
      aria-label={`Theme: ${mode}`}
    >
      <Icon className="size-[18px]" />
    </button>
  );
}

function UserMenu() {
  const { data: app } = useApp();
  const [open, setOpen] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);
  const qc = useQueryClient();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  if (!app) return null;
  const initials = app.user.username.slice(0, 2).toUpperCase();
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="grid size-9 place-items-center rounded-xl bg-gradient-to-br from-accent to-accent-strong text-xs font-bold text-white shadow-md"
        aria-label="Account"
      >
        {initials}
      </button>
      {open && (
        <div className="fade-up absolute right-0 z-50 mt-2 w-60 rounded-xl border border-line bg-elev p-1.5 shadow-2xl">
          <div className="px-3 py-2">
            <div className="truncate text-sm font-semibold">{app.user.username}</div>
            <div className="text-xs text-muted capitalize">
              {app.user.role} · {app.user.source === 'jellyfin' ? 'Jellyfin account' : app.user.source === 'local' ? 'Local account' : 'Single sign-on'}
            </div>
          </div>
          <div className="my-1 h-px bg-line" />
          {app.user.source === 'local' && (
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setPwOpen(true);
              }}
              className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-muted hover:bg-card-hover hover:text-fg"
            >
              <KeyRound className="size-4" /> Change password
            </button>
          )}
          {app.authMode === 'local' && (
            <button
              type="button"
              onClick={async () => {
                await api.post('/api/auth/logout').catch(() => undefined);
                qc.clear();
                window.location.href = '/';
              }}
              className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-muted hover:bg-card-hover hover:text-fg"
            >
              <LogOut className="size-4" /> Sign out
            </button>
          )}
          <div className="px-3 pt-1 pb-1.5 text-[11px] text-subtle">AIO Arr v{app.version}</div>
        </div>
      )}
      <PasswordModal open={pwOpen} onClose={() => setPwOpen(false)} />
    </div>
  );
}

function PasswordModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post('/api/auth/password', { current, password: next });
      toast.success('Password changed');
      setCurrent('');
      setNext('');
      onClose();
    } catch (err) {
      toast.error('Could not change password', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} size="sm" title="Change password">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Current password">
          <input type="password" className="input" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
        </Field>
        <Field label="New password" hint="At least 8 characters">
          <input type="password" className="input" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" minLength={8} required />
        </Field>
        <div className="flex justify-end">
          <Button type="submit" variant="primary" loading={busy}>
            Save
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const { path } = useRouter();
  useEffect(() => setMobileOpen(false), [path]);
  return (
    <div className="min-h-dvh">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 border-r border-line bg-elev lg:block">
        <Sidebar />
      </aside>
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-[var(--scrim)] backdrop-blur-sm" onClick={() => setMobileOpen(false)} />
          <aside className="fade-up absolute inset-y-0 left-0 w-72 border-r border-line bg-elev shadow-2xl">
            <button type="button" className="absolute top-4 right-3 rounded-lg p-1.5 text-muted hover:bg-card-hover" onClick={() => setMobileOpen(false)} aria-label="Close menu">
              <X className="size-5" />
            </button>
            <Sidebar onNavigate={() => setMobileOpen(false)} />
          </aside>
        </div>
      )}
      <div className="lg:pl-64">
        <header className="sticky top-0 z-20 border-b border-line bg-bg/80 backdrop-blur-xl">
          <div className="mx-auto flex h-16 max-w-[1600px] items-center gap-3 px-4 sm:px-6">
            <button type="button" className="grid size-9 place-items-center rounded-xl text-muted hover:bg-card-hover lg:hidden" onClick={() => setMobileOpen(true)} aria-label="Open menu">
              <Menu className="size-5" />
            </button>
            <SearchBox />
            <div className="ml-auto flex items-center gap-2">
              <SpeedPill />
              <ThemeButton />
              <UserMenu />
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-[1600px] px-4 py-6 sm:px-6 sm:py-8">{children}</main>
      </div>
    </div>
  );
}
