import clsx from 'clsx';
import {
  ArrowUpCircle,
  ChevronDown,
  CircleCheck,
  CircleX,
  Download,
  FolderOpen,
  KeyRound,
  Lock,
  MonitorPlay,
  Plus,
  Radar,
  Save,
  Server,
  Settings as SettingsIcon,
  SlidersHorizontal,
  Trash,
  UserPlus,
  Users,
  Wand,
} from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage } from '../lib/api';
import { useAddOptions } from '../lib/queries';
import { useRouter } from '../lib/router';
import type { LibraryPath, PathCheck, ServiceConfig, Settings, SettingsResponse } from '../lib/settings';
import type { ContentType } from '../lib/types';
import { Modal, useConfirm, useToast } from '../components/overlay';
import { Badge, Button, ErrorNote, Field, IconButton, InfoNote, PageHeader, Select, Skeleton, Switch, Tabs } from '../components/ui';
import { OpenWithPanel } from './SettingsOpenWith';
import { UpdatesPanel } from './SettingsUpdates';

interface Discovered {
  id: string;
  name: string;
  group: 'services' | 'clients';
  url: string;
  version?: string;
  apiKey?: string;
  username?: string;
  password?: string;
  note?: string;
}

type Group = 'services' | 'clients';

const SERVICE_GROUPS: { title: string; desc: string; ids: string[] }[] = [
  { title: 'Media managers', desc: 'Find, download and organise movies, shows, music and books', ids: ['radarr', 'sonarr', 'lidarr', 'readarr', 'prowlarr', 'bazarr'] },
  { title: 'Players & readers', desc: 'Where you watch, listen and read - choose which opens what under “Open with”', ids: ['jellyfin', 'plex', 'emby', 'navidrome', 'audiobookshelf', 'komga', 'kavita'] },
  { title: 'Recommendations & artwork', desc: 'Personal suggestions on the home page and pictures in search results', ids: ['tmdb', 'jellyseerr'] },
];
const CLIENT_ORDER = ['qbittorrent', 'transmission', 'deluge', 'sabnzbd', 'nzbget'];

const INFO: Record<
  string,
  {
    name: string;
    desc: string;
    fields: ('apiKey' | 'username' | 'password')[];
    keyLabel?: string;
    keyHint?: string;
    userLabel?: string;
    publicUrl?: boolean;
    publicHint?: string;
    noUrl?: boolean;
    placeholder?: string;
  }
> = {
  radarr: { name: 'Radarr', desc: 'Movies', fields: ['apiKey'], keyHint: 'Radarr → Settings → General → API Key' },
  sonarr: { name: 'Sonarr', desc: 'TV shows', fields: ['apiKey'], keyHint: 'Sonarr → Settings → General → API Key' },
  lidarr: { name: 'Lidarr', desc: 'Music', fields: ['apiKey'], keyHint: 'Lidarr → Settings → General → API Key' },
  readarr: { name: 'Readarr', desc: 'Books & audiobooks (legacy)', fields: ['apiKey'], keyHint: 'Readarr → Settings → General → API Key' },
  prowlarr: { name: 'Prowlarr', desc: 'Indexers - powers "search everything"', fields: ['apiKey'], keyHint: 'Prowlarr → Settings → General → API Key' },
  bazarr: { name: 'Bazarr', desc: 'Subtitles', fields: ['apiKey'], keyHint: 'Bazarr → Settings → General → API Key' },
  jellyfin: { name: 'Jellyfin', desc: 'Watch & listen - one-click play links', fields: ['apiKey'], keyHint: 'Dashboard → API Keys, or use “Create key” below', publicUrl: true },
  plex: {
    name: 'Plex',
    desc: 'Watch & listen - one-click play links',
    fields: ['apiKey'],
    keyLabel: 'Plex token',
    keyHint: 'Plex Web → any movie → ⋯ → Get Info → View XML: copy X-Plex-Token from the address bar',
    publicUrl: true,
    publicHint: 'Your Plex address, e.g. http://192.168.1.10:32400 - leave empty to open Plex on app.plex.tv',
    placeholder: 'https://app.plex.tv/desktop',
  },
  emby: { name: 'Emby', desc: 'Watch & listen - one-click play links', fields: ['apiKey'], keyHint: 'Settings → Advanced → API Keys, or use “Create key” below', publicUrl: true },
  navidrome: { name: 'Navidrome', desc: 'Music streaming', fields: ['username', 'password'], publicUrl: true },
  audiobookshelf: { name: 'Audiobookshelf', desc: 'Audiobooks, podcasts & ebooks', fields: ['apiKey'], keyLabel: 'API token', keyHint: 'Settings → Users → your user → API token (or Settings → API Keys)', publicUrl: true },
  komga: {
    name: 'Komga',
    desc: 'Comics, manga & ebooks',
    fields: ['apiKey', 'username', 'password'],
    keyHint: 'Account settings → API keys - or leave empty and use your email + password',
    userLabel: 'Email',
    publicUrl: true,
  },
  kavita: { name: 'Kavita', desc: 'Comics, manga & ebooks', fields: ['apiKey'], keyHint: 'Your user menu → Settings → 3rd Party Clients (or API Key / OPDS)', publicUrl: true },
  jellyseerr: { name: 'Jellyseerr / Overseerr', desc: 'Recommendations for movies & shows', fields: ['apiKey'], keyHint: 'Settings → General → API Key' },
  tmdb: {
    name: 'TMDB',
    desc: 'Recommendations & posters - needs a free API key',
    fields: ['apiKey'],
    keyLabel: 'API key or read access token',
    keyHint: 'Free: sign up at themoviedb.org → Settings → API',
    noUrl: true,
  },
  qbittorrent: { name: 'qBittorrent', desc: 'Torrents', fields: ['username', 'password'] },
  transmission: { name: 'Transmission', desc: 'Torrents', fields: ['username', 'password'] },
  deluge: { name: 'Deluge', desc: 'Torrents', fields: ['password'] },
  sabnzbd: { name: 'SABnzbd', desc: 'Usenet', fields: ['apiKey'], keyHint: 'Config → General → API Key' },
  nzbget: { name: 'NZBGet', desc: 'Usenet', fields: ['username', 'password'] },
};

/* ------------------------------ helpers ------------------------------ */

function LockedHint({ locked }: { locked: boolean }) {
  if (!locked) return null;
  return (
    <span className="ml-1 inline-flex items-center gap-1 text-[10px] font-medium text-subtle" title="Set by an environment variable - change it in your docker compose / .env">
      <Lock className="size-3" /> env
    </span>
  );
}

function TextField({ label, value, onChange, locked, type = 'text', placeholder, hint, autoComplete }: { label: string; value: string; onChange: (v: string) => void; locked?: boolean; type?: string; placeholder?: string; hint?: ReactNode; autoComplete?: string }) {
  return (
    <Field label={<>{label}<LockedHint locked={!!locked} /></>} hint={hint}>
      <input className="input" type={type} value={value} onChange={(e) => onChange(e.target.value)} disabled={locked} placeholder={placeholder} autoComplete={autoComplete || 'off'} spellCheck={false} />
    </Field>
  );
}

/* ------------------------------ service card ------------------------------ */

function ArrDefaults({ id, cfg, update }: { id: string; cfg: ServiceConfig; update: (patch: Partial<ServiceConfig>) => void }) {
  const { data: opts, error, isLoading } = useAddOptions(id);
  const d = cfg.defaults || {};
  const set = (k: keyof ServiceConfig['defaults'], v: unknown) => update({ defaults: { ...d, [k]: v } });
  if (isLoading) return <Skeleton className="h-16" />;
  if (error || !opts) return <div className="text-xs text-subtle">Save and test the connection to choose defaults for new items.</div>;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Default quality profile">
        <Select value={d.qualityProfileId ?? ''} onChange={(e) => set('qualityProfileId', e.target.value ? Number(e.target.value) : undefined)}>
          <option value="">Automatic</option>
          {opts.qualityProfiles.map((q) => (
            <option key={q.id} value={q.id}>
              {q.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Default root folder">
        <Select value={d.rootFolderPath ?? ''} onChange={(e) => set('rootFolderPath', e.target.value || undefined)}>
          <option value="">Automatic</option>
          {opts.rootFolders.map((r) => (
            <option key={r.path} value={r.path}>
              {r.path}
            </option>
          ))}
        </Select>
      </Field>
      {opts.metadataProfiles && (
        <Field label="Default metadata profile">
          <Select value={d.metadataProfileId ?? ''} onChange={(e) => set('metadataProfileId', e.target.value ? Number(e.target.value) : undefined)}>
            <option value="">Automatic</option>
            {opts.metadataProfiles.map((q) => (
              <option key={q.id} value={q.id}>
                {q.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {id === 'sonarr' && (
        <Field label="Monitor new shows">
          <Select value={d.monitor || 'all'} onChange={(e) => set('monitor', e.target.value)}>
            <option value="all">All episodes</option>
            <option value="future">Future episodes</option>
            <option value="missing">Missing episodes</option>
            <option value="firstSeason">First season</option>
            <option value="lastSeason">Last season</option>
            <option value="pilot">Pilot</option>
          </Select>
        </Field>
      )}
      {id === 'radarr' && (
        <Field label="Minimum availability">
          <Select value={d.minimumAvailability || 'released'} onChange={(e) => set('minimumAvailability', e.target.value)}>
            <option value="announced">Announced</option>
            <option value="inCinemas">In cinemas</option>
            <option value="released">Released</option>
          </Select>
        </Field>
      )}
      <label className="flex items-center gap-3 text-sm sm:col-span-2">
        <Switch checked={d.searchOnAdd !== false} onChange={(v) => set('searchOnAdd', v)} label="Search on add" /> Start searching as soon as something is added
      </label>
    </div>
  );
}

function JellyfinHelpers({ product, cfg, update }: { product: 'jellyfin' | 'emby'; cfg: ServiceConfig; update: (patch: Partial<ServiceConfig>) => void }) {
  const [open, setOpen] = useState(false);
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const aName = product === 'emby' ? 'an Emby' : 'a Jellyfin';
  const { data: users } = useQuery({
    queryKey: ['jf-users', product, cfg.url, cfg.enabled],
    queryFn: () => api.get<{ id: string; name: string; admin: boolean }[]>(`/api/settings/jellyfin-users?product=${product}`),
    enabled: cfg.enabled,
    retry: false,
  });
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field
        label="Home screen user"
        hint={product === 'emby' ? 'Whose watch history the recommendations are based on' : 'Whose “continue watching”, “recently added” and recommendations to show (Jellyfin sign-ins use their own)'}
      >
        <Select value={cfg.userId || ''} onChange={(e) => update({ userId: e.target.value })}>
          <option value="">First administrator</option>
          {(users || []).map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
              {u.admin ? ' (admin)' : ''}
            </option>
          ))}
        </Select>
      </Field>
      <div className="flex items-end">
        <Button variant="secondary" icon={KeyRound} onClick={() => setOpen(true)}>
          Create API key with admin login
        </Button>
      </div>
      <Modal open={open} onClose={() => setOpen(false)} size="sm" title={`Create ${aName} API key`}>
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              const r = await api.post<{ apiKey: string }>('/api/settings/jellyfin-key', { url: cfg.url, username: user, password: pass, product });
              update({ apiKey: r.apiKey, enabled: true });
              toast.success('API key created', 'Remember to save your settings.');
              setOpen(false);
            } catch (err) {
              toast.error('Could not create key', errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <p className="text-sm text-muted">Sign in with {aName} administrator. Your password is only used once and never stored.</p>
          <TextField label="Username" value={user} onChange={setUser} autoComplete="username" />
          <TextField label="Password" type="password" value={pass} onChange={setPass} autoComplete="current-password" />
          <div className="flex justify-end">
            <Button type="submit" variant="primary" loading={busy}>
              Create key
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

function ServiceCard({ group, id, cfg, locked, update, savedEnabled }: { group: Group; id: string; cfg: ServiceConfig; locked: (p: string) => boolean; update: (patch: Partial<ServiceConfig>) => void; savedEnabled: boolean }) {
  const info = INFO[id];
  const [open, setOpen] = useState(cfg.enabled);
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const L = (field: string) => locked(`${group}.${id}.${field}`);
  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      const r = await api.post<{ message: string }>('/api/settings/test', { group, id, config: cfg });
      setTest({ ok: true, message: r.message });
    } catch (err) {
      setTest({ ok: false, message: errorMessage(err) });
    } finally {
      setTesting(false);
    }
  };
  const isArr = ['radarr', 'sonarr', 'lidarr', 'readarr'].includes(id);
  return (
    <div className={clsx('card overflow-hidden transition-opacity', !cfg.enabled && 'opacity-80')}>
      <div className="flex items-center gap-3 p-4">
        <button type="button" onClick={() => setOpen((v) => !v)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
          <ChevronDown className={clsx('size-4 shrink-0 text-subtle transition-transform', !open && '-rotate-90')} />
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-semibold">
              {info.name}
              {test && (test.ok ? <CircleCheck className="size-4 text-ok" /> : <CircleX className="size-4 text-bad" />)}
            </div>
            <div className="truncate text-xs text-muted">{info.desc}</div>
          </div>
        </button>
        <Switch
          checked={cfg.enabled}
          disabled={L('enabled')}
          onChange={(v) => {
            update({ enabled: v });
            if (v) setOpen(true);
          }}
          label={`Enable ${info.name}`}
        />
      </div>
      {open && (
        <div className="space-y-4 border-t border-line p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            {!info.noUrl && (
              <>
                <TextField label="Internal URL" value={cfg.url} onChange={(v) => update({ url: v })} locked={L('url')} placeholder={`http://${id}:port`} hint="How AIO Arr reaches it (docker name + port, include any URL base)" />
                <TextField
                  label={info.publicUrl ? 'Public URL (for your browser)' : 'Public URL (optional)'}
                  value={cfg.publicUrl}
                  onChange={(v) => update({ publicUrl: v })}
                  locked={L('publicUrl')}
                  placeholder={info.placeholder || `https://${id}.example.com`}
                  hint={info.publicHint || (info.publicUrl ? 'Used for “Watch / Listen / Read” links - e.g. its subdomain' : 'Used for “Open in …” links')}
                />
              </>
            )}
            {info.fields.includes('apiKey') && (
              <TextField label={info.keyLabel || 'API key'} type="password" value={cfg.apiKey} onChange={(v) => update({ apiKey: v })} locked={L('apiKey')} hint={info.keyHint} />
            )}
            {info.fields.includes('username') && <TextField label={info.userLabel || 'Username'} value={cfg.username} onChange={(v) => update({ username: v })} locked={L('username')} />}
            {info.fields.includes('password') && <TextField label="Password" type="password" value={cfg.password} onChange={(v) => update({ password: v })} locked={L('password')} />}
          </div>
          {(id === 'jellyfin' || id === 'emby') && <JellyfinHelpers product={id} cfg={cfg} update={update} />}
          {isArr && savedEnabled && (
            <div className="rounded-xl border border-line bg-inset/50 p-3.5">
              <div className="mb-3 flex items-center gap-2 text-xs font-semibold tracking-wide text-muted uppercase">
                <SlidersHorizontal className="size-3.5" /> Defaults for new {id === 'radarr' ? 'movies' : id === 'sonarr' ? 'shows' : id === 'lidarr' ? 'artists' : 'books'}
              </div>
              <ArrDefaults id={id} cfg={cfg} update={update} />
            </div>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" variant="secondary" icon={Radar} loading={testing} onClick={() => void runTest()} disabled={!cfg.url}>
              Test connection
            </Button>
            {test && <span className={clsx('text-sm', test.ok ? 'text-ok' : 'text-bad')}>{test.message}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------ users ------------------------------ */

function UsersPanel() {
  const { data, refetch, isLoading } = useQuery({ queryKey: ['users'], queryFn: () => api.get<{ username: string; role: 'admin' | 'user'; createdAt: string }[]>('/api/users') });
  const [name, setName] = useState('');
  const [pass, setPass] = useState('');
  const [role, setRole] = useState<'admin' | 'user'>('user');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const confirm = useConfirm();
  const call = async (fn: () => Promise<unknown>, msg: string) => {
    try {
      await fn();
      toast.success(msg);
      void refetch();
    } catch (err) {
      toast.error('Failed', errorMessage(err));
    }
  };
  return (
    <div className="space-y-5">
      <InfoNote>
        Admins can change settings and delete things. Users can search, download, watch and listen. Jellyfin accounts can also sign in if you enable it under General.
      </InfoNote>
      <div className="card divide-y divide-line">
        {isLoading && <Skeleton className="m-3 h-10" />}
        {(data || []).map((u) => (
          <div key={u.username} className="flex flex-wrap items-center gap-3 p-3.5">
            <div className="grid size-9 place-items-center rounded-xl bg-accent/15 text-xs font-bold text-accent">{u.username.slice(0, 2).toUpperCase()}</div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold">{u.username}</div>
              <div className="text-xs text-muted">since {new Date(u.createdAt).toLocaleDateString()}</div>
            </div>
            <Select value={u.role} className="!h-9 w-28" onChange={(e) => void call(() => api.put(`/api/users/${encodeURIComponent(u.username)}`, { role: e.target.value }), 'Role updated')}>
              <option value="admin">Admin</option>
              <option value="user">User</option>
            </Select>
            <Button
              size="sm"
              variant="ghost"
              icon={KeyRound}
              onClick={async () => {
                const pw = window.prompt(`New password for ${u.username} (min. 8 characters)`);
                if (pw) await call(() => api.put(`/api/users/${encodeURIComponent(u.username)}`, { password: pw }), 'Password changed');
              }}
            >
              Password
            </Button>
            <IconButton
              icon={Trash}
              label="Delete user"
              onClick={async () => {
                if (await confirm({ title: `Delete ${u.username}?`, confirmLabel: 'Delete', danger: true })) await call(() => api.del(`/api/users/${encodeURIComponent(u.username)}`), 'User deleted');
              }}
            />
          </div>
        ))}
      </div>
      <form
        className="card grid gap-3 p-4 sm:grid-cols-[1fr_1fr_140px_auto] sm:items-end"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          await call(() => api.post('/api/users', { username: name, password: pass, role }), `${name} added`);
          setName('');
          setPass('');
          setBusy(false);
        }}
      >
        <TextField label="New username" value={name} onChange={setName} />
        <TextField label="Password" type="password" value={pass} onChange={setPass} autoComplete="new-password" />
        <Field label="Role">
          <Select value={role} onChange={(e) => setRole(e.target.value as 'admin' | 'user')}>
            <option value="user">User</option>
            <option value="admin">Admin</option>
          </Select>
        </Field>
        <Button type="submit" variant="primary" icon={UserPlus} loading={busy} disabled={!name || pass.length < 8}>
          Add
        </Button>
      </form>
    </div>
  );
}

/* ------------------------------ page ------------------------------ */

type Tab = 'apps' | 'clients' | 'open-with' | 'updates' | 'folders' | 'general' | 'users';
const TABS: Tab[] = ['apps', 'clients', 'open-with', 'updates', 'folders', 'general', 'users'];

type PathChecks = { downloads: PathCheck[] } & Record<LibraryPath, PathCheck>;

export function SettingsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const { search, navigate } = useRouter();
  const { data, isLoading, error } = useQuery({ queryKey: ['settings'], queryFn: () => api.get<SettingsResponse>('/api/settings') });
  const [draft, setDraft] = useState<Settings | null>(null);
  const tab: Tab = TABS.includes(search.get('tab') as Tab) ? (search.get('tab') as Tab) : 'apps';
  const setTab = (t: Tab) => navigate(t === 'apps' ? '/settings' : `/settings?tab=${t}`, { replace: true });
  const [saving, setSaving] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [found, setFound] = useState<Discovered[] | null>(null);
  const pathCheck = useQuery({
    queryKey: ['paths-check'],
    queryFn: () => api.get<PathChecks>('/api/settings/paths-check'),
    enabled: tab === 'folders' || tab === 'open-with',
  });

  useEffect(() => {
    if (data && !draft) setDraft(structuredClone(data.settings));
  }, [data, draft]);

  const dirty = useMemo(() => !!data && !!draft && JSON.stringify(data.settings) !== JSON.stringify(draft), [data, draft]);
  const locked = (p: string) => !!data?.locked.includes(p);

  if (isLoading || !draft) return error ? <ErrorNote>{errorMessage(error)}</ErrorNote> : <Skeleton className="h-96" />;

  const updateSvc = (group: Group, id: string) => (patch: Partial<ServiceConfig>) =>
    setDraft((d) => (d ? { ...d, [group]: { ...d[group], [id]: { ...d[group][id], ...patch } } } : d));
  const setPaths = (patch: Partial<Settings['paths']>) => setDraft((d) => (d ? { ...d, paths: { ...d.paths, ...patch } } : d));
  const setPlayer = (t: ContentType, v: string) => setDraft((d) => (d ? { ...d, players: { ...d.players, [t]: v } } : d));
  const setGeneral = (patch: Partial<Settings['general']>) => setDraft((d) => (d ? { ...d, general: { ...d.general, ...patch } } : d));

  const save = async () => {
    setSaving(true);
    try {
      const res = await api.put<SettingsResponse>('/api/settings', draft);
      qc.setQueryData(['settings'], res);
      setDraft(structuredClone(res.settings));
      toast.success('Settings saved');
      void qc.invalidateQueries();
      void pathCheck.refetch();
    } catch (err) {
      toast.error('Could not save settings', errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const discover = async () => {
    setDiscovering(true);
    try {
      setFound(await api.post<Discovered[]>('/api/settings/discover'));
    } catch (err) {
      toast.error('Auto-detect failed', errorMessage(err));
    } finally {
      setDiscovering(false);
    }
  };

  const applyFound = () => {
    if (!found) return;
    setDraft((d) => {
      if (!d) return d;
      const next = structuredClone(d);
      for (const f of found) {
        const cur = next[f.group][f.id];
        next[f.group][f.id] = {
          ...cur,
          enabled: true,
          url: locked(`${f.group}.${f.id}.url`) ? cur.url : f.url,
          apiKey: f.apiKey && !locked(`${f.group}.${f.id}.apiKey`) ? f.apiKey : cur.apiKey,
          username: f.username && !cur.username ? f.username : cur.username,
          password: f.password && !cur.password ? f.password : cur.password,
        };
      }
      return next;
    });
    toast.info('Detected services filled in', 'Add any missing keys or passwords, then press Save.');
    setFound(null);
  };

  return (
    <div className="pb-24">
      <PageHeader
        icon={SettingsIcon}
        title="Settings"
        subtitle="Connect your services once - everything else happens from this page"
        actions={
          <Button variant="secondary" icon={Wand} loading={discovering} onClick={() => void discover()}>
            Auto-detect services
          </Button>
        }
      />
      <Tabs
        className="mb-6"
        value={tab}
        onChange={setTab}
        items={[
          { value: 'apps', label: 'Apps', icon: Server },
          { value: 'clients', label: 'Download clients', icon: Download },
          { value: 'open-with', label: 'Open with', icon: MonitorPlay },
          { value: 'updates', label: 'Updates', icon: ArrowUpCircle },
          { value: 'folders', label: 'Folders', icon: FolderOpen },
          { value: 'general', label: 'General', icon: SlidersHorizontal },
          { value: 'users', label: 'Users', icon: Users },
        ]}
      />

      {tab === 'apps' && (
        <div className="space-y-8">
          {SERVICE_GROUPS.map((g) => (
            <section key={g.title}>
              <div className="mb-3">
                <h2 className="text-[15px] font-semibold tracking-tight">{g.title}</h2>
                <p className="text-xs text-muted">{g.desc}</p>
              </div>
              <div className="grid gap-3 xl:grid-cols-2">
                {g.ids
                  .filter((id) => draft.services[id])
                  .map((id) => (
                    <ServiceCard key={id} group="services" id={id} cfg={draft.services[id]} locked={locked} update={updateSvc('services', id)} savedEnabled={!!data?.settings.services[id]?.enabled} />
                  ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {tab === 'open-with' && <OpenWithPanel draft={draft} openWith={data?.openWith} locked={locked} checks={pathCheck.data} setPlayer={setPlayer} setPaths={setPaths} />}

      {tab === 'updates' && <UpdatesPanel />}

      {tab === 'clients' && (
        <div className="space-y-4">
          <InfoNote>
            The *arr apps keep using their own download-client settings. Connecting the clients here adds live speeds, pause/resume, and lets AIO Arr send things you grab from the indexer search straight to them.
          </InfoNote>
          <div className="grid gap-3 xl:grid-cols-2">
            {CLIENT_ORDER.map((id) => (
              <ServiceCard key={id} group="clients" id={id} cfg={draft.clients[id]} locked={locked} update={updateSvc('clients', id)} savedEnabled={!!data?.settings.clients[id]?.enabled} />
            ))}
          </div>
        </div>
      )}

      {tab === 'folders' && (
        <div className="max-w-3xl space-y-6">
          <InfoNote>
            Paths are as seen <b>inside the AIO Arr container</b>. Easiest: mount your whole data folder (e.g. <code className="font-mono">/data</code>) exactly like your download client and *arr apps do. The library
            folders for music, audiobooks, books and comics are under <b>Open with</b>.
          </InfoNote>
          <div className="card space-y-3 p-5">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-semibold">
                  Download folders shown in Files <LockedHint locked={locked('paths.downloads')} />
                </div>
                <div className="text-xs text-muted">Leave empty to use the folders your download clients report.</div>
              </div>
              <Button size="sm" variant="ghost" icon={Plus} disabled={locked('paths.downloads')} onClick={() => setPaths({ downloads: [...draft.paths.downloads, ''] })}>
                Add
              </Button>
            </div>
            {draft.paths.downloads.map((p, i) => (
              <div key={i} className="flex gap-2">
                <input className="input font-mono" value={p} disabled={locked('paths.downloads')} placeholder="/data/torrents" onChange={(e) => setPaths({ downloads: draft.paths.downloads.map((x, j) => (j === i ? e.target.value : x)) })} />
                <IconButton icon={Trash} label="Remove" disabled={locked('paths.downloads')} onClick={() => setPaths({ downloads: draft.paths.downloads.filter((_, j) => j !== i) })} />
              </div>
            ))}
          </div>
          <div className="card space-y-3 p-5">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-semibold">
                  Path mappings <LockedHint locked={locked('paths.mappings')} />
                </div>
                <div className="text-xs text-muted">Only needed if your download client sees files under a different path than AIO Arr.</div>
              </div>
              <Button size="sm" variant="ghost" icon={Plus} disabled={locked('paths.mappings')} onClick={() => setPaths({ mappings: [...draft.paths.mappings, { from: '', to: '' }] })}>
                Add
              </Button>
            </div>
            {draft.paths.mappings.map((m, i) => (
              <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-2">
                <input className="input font-mono" placeholder="Client path: /downloads" value={m.from} disabled={locked('paths.mappings')} onChange={(e) => setPaths({ mappings: draft.paths.mappings.map((x, j) => (j === i ? { ...x, from: e.target.value } : x)) })} />
                <input className="input font-mono" placeholder="AIO path: /data/torrents" value={m.to} disabled={locked('paths.mappings')} onChange={(e) => setPaths({ mappings: draft.paths.mappings.map((x, j) => (j === i ? { ...x, to: e.target.value } : x)) })} />
                <IconButton icon={Trash} label="Remove" disabled={locked('paths.mappings')} onClick={() => setPaths({ mappings: draft.paths.mappings.filter((_, j) => j !== i) })} />
              </div>
            ))}
          </div>
          {pathCheck.data && (
            <div className="card p-5 text-sm">
              <div className="mb-2 font-semibold">Saved folders, as seen by the container</div>
              {[...pathCheck.data.downloads, ...(['music', 'audiobooks', 'ebooks', 'comics'] as const).map((k) => pathCheck.data[k])].map((v) => {
                if (!v?.path) return null;
                return (
                  <div key={v.path} className="flex items-center gap-2 py-1">
                    {v.exists && v.writable ? <CircleCheck className="size-4 text-ok" /> : <CircleX className="size-4 text-bad" />}
                    <span className="font-mono text-xs">{v.path}</span>
                    <span className="text-xs text-muted">{!v.exists ? 'not found - check your volume mounts' : !v.writable ? 'read-only - AIO Arr cannot place files here' : 'ok'}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {tab === 'general' && (
        <div className="card max-w-3xl space-y-4 p-5">
          <Field label={<>App name<LockedHint locked={locked('general.title')} /></>}>
            <input className="input" value={draft.general.title} disabled={locked('general.title')} onChange={(e) => setGeneral({ title: e.target.value })} />
          </Field>
          <Field label={<>Sign in with Jellyfin accounts<LockedHint locked={locked('general.jellyfinLogin')} /></>} hint="Lets people use their Jellyfin username & password here">
            <Select value={draft.general.jellyfinLogin} disabled={locked('general.jellyfinLogin')} onChange={(e) => setGeneral({ jellyfinLogin: e.target.value as Settings['general']['jellyfinLogin'] })}>
              <option value="off">Off</option>
              <option value="admins">Jellyfin administrators only</option>
              <option value="all">All Jellyfin users (non-admins get the “user” role)</option>
            </Select>
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Send torrents from indexer search to">
              <Select value={draft.general.torrentClient} disabled={locked('general.torrentClient')} onChange={(e) => setGeneral({ torrentClient: e.target.value })}>
                <option value="">First connected torrent client</option>
                {['qbittorrent', 'transmission', 'deluge'].map((c) => (
                  <option key={c} value={c}>
                    {INFO[c].name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Send NZBs from indexer search to">
              <Select value={draft.general.usenetClient} disabled={locked('general.usenetClient')} onChange={(e) => setGeneral({ usenetClient: e.target.value })}>
                <option value="">First connected usenet client</option>
                {['sabnzbd', 'nzbget'].map((c) => (
                  <option key={c} value={c}>
                    {INFO[c].name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field
            label="Download category prefix"
            hint={`Direct downloads use the categories ${draft.general.categoryPrefix || 'aio'}-music, -audiobook, -ebook, -comic and -files in your download client`}
          >
            <input className="input" value={draft.general.categoryPrefix} disabled={locked('general.categoryPrefix')} onChange={(e) => setGeneral({ categoryPrefix: e.target.value.replace(/[^a-zA-Z0-9_-]/g, '') })} />
          </Field>
          <div className="flex items-start gap-3 rounded-xl border border-line p-3.5">
            <Switch checked={draft.general.onlineArtwork} disabled={locked('general.onlineArtwork')} onChange={(v) => setGeneral({ onlineArtwork: v })} label="Pictures from public sites" />
            <div className="text-sm">
              <div className="font-medium">
                Look up pictures on public sites
                <LockedHint locked={locked('general.onlineArtwork')} />
              </div>
              <div className="text-xs text-muted">
                Search results for games, books, comics, music and apps get cover art from Apple, Open Library, Google Books, Steam and Wikipedia (only the title is sent). Movies and shows use Radarr, Sonarr and TMDB first.
              </div>
            </div>
          </div>
        </div>
      )}

      {tab === 'users' && <UsersPanel />}

      {tab !== 'users' && tab !== 'updates' && (
        <div className={clsx('fixed inset-x-0 bottom-0 z-30 border-t border-line bg-elev/95 backdrop-blur-xl transition-all lg:left-64', dirty ? 'translate-y-0' : 'invisible translate-y-full')}>
          <div className="mx-auto flex max-w-[1600px] items-center justify-between gap-3 px-4 py-3 sm:px-6">
            <div className="flex items-center gap-2 text-sm text-muted">
              <Badge tone="warn">Unsaved</Badge> You have unsaved changes
            </div>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => data && setDraft(structuredClone(data.settings))}>
                Discard
              </Button>
              <Button variant="primary" icon={Save} loading={saving} onClick={() => void save()}>
                Save changes
              </Button>
            </div>
          </div>
        </div>
      )}

      <Modal open={!!found} onClose={() => setFound(null)} size="md" title="Detected services">
        {found && (
          <div className="space-y-4">
            {found.length === 0 ? (
              <p className="text-sm text-muted">Nothing found on the usual addresses. Make sure AIO Arr is on the same docker network as your apps (see the README), or enter the URLs by hand.</p>
            ) : (
              <>
                <div className="divide-y divide-line rounded-xl border border-line">
                  {found.map((f) => (
                    <div key={f.id} className="flex items-start gap-3 p-3">
                      <CircleCheck className="mt-0.5 size-4 shrink-0 text-ok" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 text-sm font-semibold">
                          {f.name} {f.version && <span className="text-xs font-normal text-subtle">v{String(f.version).replace(/^v/, '')}</span>}
                          {f.apiKey && <Badge tone="ok">API key found</Badge>}
                        </div>
                        <div className="font-mono text-xs text-muted">{f.url}</div>
                        {f.note && !f.apiKey && <div className="mt-0.5 text-xs text-warn">{f.note}</div>}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" onClick={() => setFound(null)}>
                    Cancel
                  </Button>
                  <Button variant="primary" onClick={applyFound}>
                    Use these
                  </Button>
                </div>
              </>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
