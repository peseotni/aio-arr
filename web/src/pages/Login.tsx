import { CircleAlert, LogIn, ShieldCheck } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, errorMessage } from '../lib/api';
import type { AuthState } from '../lib/queries';
import { Button, Field } from '../components/ui';

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative grid min-h-dvh place-items-center overflow-hidden px-4 py-10">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -top-40 left-1/2 h-[520px] w-[820px] -translate-x-1/2 rounded-full bg-accent/25 blur-[120px]" />
        <div className="absolute right-[-10%] bottom-[-20%] h-[420px] w-[520px] rounded-full bg-info/10 blur-[120px]" />
      </div>
      <div className="relative w-full max-w-sm">{children}</div>
    </div>
  );
}

export function LoginPage({ auth }: { auth: AuthState }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const qc = useQueryClient();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.post('/api/auth/login', { username, password, remember });
      await qc.invalidateQueries();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell>
      <div className="mb-8 flex flex-col items-center text-center">
        <img src="/favicon.svg" alt="" className="mb-4 size-14 rounded-2xl shadow-2xl shadow-accent/40" />
        <h1 className="text-2xl font-bold tracking-tight">{auth.title}</h1>
        <p className="mt-1.5 text-sm text-muted">One sign-in for your whole media stack</p>
      </div>
      <form onSubmit={submit} className="card space-y-4 p-6">
        <Field label="Username">
          <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus required />
        </Field>
        <Field label="Password">
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </Field>
        <label className="flex items-center gap-2 text-sm text-muted">
          <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          Keep me signed in
        </label>
        {error && (
          <div className="flex items-center gap-2 rounded-lg bg-bad/10 px-3 py-2 text-sm text-bad">
            <CircleAlert className="size-4 shrink-0" /> {error}
          </div>
        )}
        <Button type="submit" variant="primary" size="lg" icon={LogIn} loading={busy} className="w-full">
          Sign in
        </Button>
        {auth.jellyfinLogin && <p className="text-center text-xs text-subtle">You can also sign in with your Jellyfin account.</p>}
      </form>
    </Shell>
  );
}

export function SetupPage({ auth }: { auth: AuthState }) {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const qc = useQueryClient();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) {
      setError('Passwords do not match');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api.post('/api/auth/setup', { username, password });
      await qc.invalidateQueries();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell>
      <div className="mb-8 flex flex-col items-center text-center">
        <img src="/favicon.svg" alt="" className="mb-4 size-14 rounded-2xl shadow-2xl shadow-accent/40" />
        <h1 className="text-2xl font-bold tracking-tight">Welcome to {auth.title}</h1>
        <p className="mt-1.5 text-sm text-muted">Create the admin account to get started.</p>
      </div>
      <form onSubmit={submit} className="card space-y-4 p-6">
        <Field label="Username">
          <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />
        </Field>
        <Field label="Password" hint="At least 8 characters">
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={8} required autoFocus />
        </Field>
        <Field label="Confirm password">
          <input className="input" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" minLength={8} required />
        </Field>
        {error && (
          <div className="flex items-center gap-2 rounded-lg bg-bad/10 px-3 py-2 text-sm text-bad">
            <CircleAlert className="size-4 shrink-0" /> {error}
          </div>
        )}
        <Button type="submit" variant="primary" size="lg" icon={ShieldCheck} loading={busy} className="w-full">
          Create account
        </Button>
      </form>
    </Shell>
  );
}
