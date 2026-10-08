/* Settings > Open with: which app opens each kind of content, and the library folders downloads go into. */
import { CircleCheck, CircleX, FileDown, Lock } from 'lucide-react';
import type { ReactNode } from 'react';
import { CONTENT_META } from '../lib/content';
import type { LibraryPath, OpenWithInfo, PathCheck, Settings } from '../lib/settings';
import type { ContentType } from '../lib/types';
import { Field, InfoNote, Select } from '../components/ui';

const VERB: Record<string, string> = { movies: 'Watch', tv: 'Watch', music: 'Listen', audiobooks: 'Listen', ebooks: 'Read', comics: 'Read' };

const LIBRARY: Partial<Record<ContentType, { key: LibraryPath; placeholder: string; apps: string }>> = {
  music: { key: 'music', placeholder: '/data/media/music', apps: 'Navidrome, Jellyfin or Plex' },
  audiobooks: { key: 'audiobooks', placeholder: '/data/media/audiobooks', apps: 'Audiobookshelf' },
  ebooks: { key: 'ebooks', placeholder: '/data/media/books', apps: 'Kavita, Komga or Audiobookshelf' },
  comics: { key: 'comics', placeholder: '/data/media/comics', apps: 'Komga or Kavita' },
};

const TYPES: ContentType[] = ['movies', 'tv', 'music', 'audiobooks', 'ebooks', 'comics'];

function Locked({ on }: { on: boolean }) {
  if (!on) return null;
  return (
    <span className="ml-1 inline-flex items-center gap-1 text-[10px] font-medium text-subtle" title="Set by an environment variable - change it in your docker compose / .env">
      <Lock className="size-3" /> env
    </span>
  );
}

function PathStatus({ check }: { check?: PathCheck }) {
  if (!check?.path) return null;
  const ok = check.exists && check.writable;
  return (
    <span className={ok ? 'text-ok' : 'text-bad'} title={!check.exists ? 'Not found inside the container - check your volume mounts' : !check.writable ? 'Read-only - AIO Arr cannot place files here' : 'Found and writable'}>
      {ok ? <CircleCheck className="size-4" /> : <CircleX className="size-4" />}
    </span>
  );
}

function Row({
  type,
  info,
  value,
  onChange,
  locked,
  children,
}: {
  type: ContentType;
  info?: OpenWithInfo;
  value: string;
  onChange: (v: string) => void;
  locked: boolean;
  children?: ReactNode;
}) {
  const m = CONTENT_META[type];
  const lib = LIBRARY[type];
  const chosen = info?.options.find((o) => o.id === value);
  const effective = value === 'download' ? undefined : chosen?.connected ? chosen : info?.auto;
  const summary =
    value === 'download'
      ? 'Downloads stay as files you save to this device'
      : effective
        ? `“${VERB[type]}” buttons open ${effective.name}${chosen && !chosen.connected ? ` (${chosen.name} is not connected)` : ''}`
        : `No app for ${m.label.toLowerCase()} is connected yet`;
  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent/12 text-accent">
          <m.icon className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">
            {m.label}
            <Locked on={locked} />
          </div>
          <div className="text-xs text-muted">{summary}</div>
        </div>
        <Select className="w-full sm:w-72" value={value} disabled={locked} onChange={(e) => onChange(e.target.value)} aria-label={`Open ${m.label.toLowerCase()} with`}>
          <option value="auto">Automatic{info?.auto ? ` (${info.auto.name})` : ''}</option>
          {(info?.options || []).map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
              {o.connected ? '' : ' - not connected'}
            </option>
          ))}
          {lib && <option value="download">Download to this computer instead</option>}
        </Select>
      </div>
      {children}
    </div>
  );
}

export function OpenWithPanel({
  draft,
  openWith,
  locked,
  checks,
  setPlayer,
  setPaths,
}: {
  draft: Settings;
  openWith?: Record<ContentType, OpenWithInfo>;
  locked: (p: string) => boolean;
  checks?: Partial<Record<LibraryPath, PathCheck>>;
  setPlayer: (t: ContentType, v: string) => void;
  setPaths: (patch: Partial<Settings['paths']>) => void;
}) {
  return (
    <div className="max-w-4xl space-y-4">
      <InfoNote>
        Pick the app that opens each kind of content - every “Watch”, “Listen” and “Read” button uses it. Music, audiobooks, books and comics you download from your indexers are put into the library folder and the app is
        asked to scan it. <b>Automatic</b> uses the first connected app.
      </InfoNote>
      {TYPES.map((t) => {
        const lib = LIBRARY[t];
        return (
          <Row key={t} type={t} info={openWith?.[t]} value={draft.players[t] || 'auto'} onChange={(v) => setPlayer(t, v)} locked={locked(`players.${t}`)}>
            {lib && (
              <div className="mt-3 border-t border-line pt-3">
                <Field
                  label={
                    <>
                      Library folder<Locked on={locked(`paths.${lib.key}`)} />
                    </>
                  }
                  hint={`As seen inside the AIO Arr container. Point ${lib.apps} at the same folder.`}
                >
                  <div className="flex items-center gap-2">
                    <input
                      className="input font-mono"
                      value={draft.paths[lib.key]}
                      disabled={locked(`paths.${lib.key}`)}
                      placeholder={lib.placeholder}
                      spellCheck={false}
                      onChange={(e) => setPaths({ [lib.key]: e.target.value } as Partial<Settings['paths']>)}
                    />
                    {checks?.[lib.key]?.path === draft.paths[lib.key] && <PathStatus check={checks?.[lib.key]} />}
                  </div>
                </Field>
              </div>
            )}
          </Row>
        );
      })}
      <div className="card flex items-center gap-3 p-4">
        <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-fg/[0.06] text-muted">
          <FileDown className="size-5" />
        </div>
        <div className="text-sm text-muted">
          <span className="font-semibold text-fg">Games, apps and everything else</span> are downloaded as files - save them to this device from Downloads or Files.
        </div>
      </div>
      <div className="card p-4">
        <Field
          label={
            <>
              How downloads are put into a library<Locked on={locked('paths.importMode')} />
            </>
          }
        >
          <Select value={draft.paths.importMode} onChange={(e) => setPaths({ importMode: e.target.value })} disabled={locked('paths.importMode')}>
            <option value="auto">Automatic - hard link torrents (keeps seeding, no extra space), move usenet</option>
            <option value="hardlink">Hard link (falls back to copy)</option>
            <option value="copy">Copy</option>
            <option value="move">Move</option>
          </Select>
        </Field>
      </div>
    </div>
  );
}
