import { useEffect, useState } from 'preact/hooks';
import type { ExplainKey } from '../../analytics';
import { wipeAll } from '../../store/db';
import type { Profile } from '../../types';
import { app } from '../controller';
import { Card } from '../components';
import { ExplainSheet } from '../explain';
import { useApp } from '../hooks';

const TOPICS: { key: ExplainKey; label: string }[] = [
  { key: 'recovery', label: 'Recovery' },
  { key: 'strain', label: 'Strain' },
  { key: 'sleep', label: 'Schlaf' },
  { key: 'hrv', label: 'HRV' },
  { key: 'restingHr', label: 'Ruhepuls' },
  { key: 'calories', label: 'Kalorien' },
];

export function ProfilePage() {
  const s = useApp();
  const [p, setP] = useState<Profile>(s.profile ?? { age: 30, weightKg: 75, sex: 'm', maxHr: 190, sleepNeedH: 8 });
  const [maxTouched, setMaxTouched] = useState(!!s.profile);
  const [saved, setSaved] = useState(false);
  const [topic, setTopic] = useState<ExplainKey | null>(null);

  useEffect(() => {
    if (s.profile) setP(s.profile);
  }, [s.profile]);

  const update = (patch: Partial<Profile>) => {
    setSaved(false);
    setP((old) => {
      const next = { ...old, ...patch };
      // Maximalpuls folgt dem Alter, solange er nicht selbst geändert wurde.
      if (patch.age != null && !maxTouched) next.maxHr = 220 - patch.age;
      return next;
    });
  };

  const valid = p.age >= 10 && p.age <= 100 && p.weightKg >= 30 && p.weightKg <= 250 && p.maxHr >= 120 && p.maxHr <= 230 && p.sleepNeedH >= 4 && p.sleepNeedH <= 12;

  return (
    <div>
      <Card title="Profil">
        <div class="form-grid">
          <NumField label="Alter (Jahre)" value={p.age} onChange={(v) => update({ age: v })} />
          <NumField label="Gewicht (kg)" value={p.weightKg} step={0.5} onChange={(v) => update({ weightKg: v })} />
          <NumField label={`Maximalpuls (Vorschlag ${220 - p.age})`} value={p.maxHr} onChange={(v) => { setMaxTouched(true); update({ maxHr: v }); }} />
          <NumField label="Schlafbedarf (h)" value={p.sleepNeedH} step={0.25} onChange={(v) => update({ sleepNeedH: v })} />
        </div>
        <div style={{ marginTop: 10 }}>
          <span class="small muted" style={{ display: 'block', marginBottom: 6 }}>Geschlecht (für die Kalorienformel)</span>
          <div class="seg">
            <button class={p.sex === 'm' ? 'on' : ''} onClick={() => update({ sex: 'm' })}>Männlich</button>
            <button class={p.sex === 'w' ? 'on' : ''} onClick={() => update({ sex: 'w' })}>Weiblich</button>
          </div>
        </div>
        <div class="small muted" style={{ marginTop: 10 }}>
          Der Maximalpuls bestimmt die Pulszonen und damit den Strain. Kennst du deinen echten Maximalpuls (z. B. aus einem Belastungstest), trag ihn ein – das ist genauer als 220 − Alter.
        </div>
        <div style={{ marginTop: 12 }}>
          <button class="btn primary" disabled={!valid} onClick={async () => { await app.saveProfile(p); setSaved(true); }}>
            {saved ? 'Gespeichert ✓' : 'Speichern & neu berechnen'}
          </button>
        </div>
      </Card>

      <Card title="Wie wird gerechnet?">
        <div class="btns two">
          {TOPICS.map((t) => <button key={t.key} class="btn" onClick={() => setTopic(t.key)}>{t.label}</button>)}
        </div>
      </Card>

      <Card title="Daten">
        <label class="field">
          <span>Rohdaten aufbewahren (Tageswerte bleiben immer)</span>
          <select value={String(s.retentionDays)} onChange={(e) => app.setRetention(Number((e.target as HTMLSelectElement).value))}>
            <option value="0">Unbegrenzt</option>
            <option value="30">30 Tage</option>
            <option value="90">90 Tage</option>
            <option value="365">1 Jahr</option>
          </select>
        </label>
        <div class="btns" style={{ marginTop: 10 }}>
          <button class="btn" disabled={s.computing} onClick={() => app.recomputeAll()}>
            {s.computing ? 'Berechne …' : 'Alle Tage neu berechnen'}
          </button>
          <button
            class="btn danger"
            onClick={async () => {
              if (confirm('Wirklich alle lokalen Daten löschen? Das lässt sich nicht rückgängig machen.')) {
                await wipeAll();
                location.reload();
              }
            }}
          >
            Alle Daten löschen
          </button>
        </div>
      </Card>

      <AccountCard />

      {topic && <ExplainSheet topic={topic} onClose={() => setTopic(null)} />}
    </div>
  );
}

// Der Server akzeptiert POST-Anfragen an /api nur als JSON (CSRF-Schutz).
const JSON_POST: RequestInit = {
  method: 'POST',
  credentials: 'same-origin',
  headers: { 'Content-Type': 'application/json' },
  body: '{}',
};

function AccountCard() {
  const [pair, setPair] = useState<{ url: string; expiresAt: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const createPair = async () => {
    setErr(null);
    try {
      const res = await fetch('/api/auth/pair', JSON_POST);
      if (res.status === 403) throw new Error('Kopplungslinks lassen sich nur nach einer Passkey-Anmeldung (Safari) erstellen.');
      if (!res.ok) throw new Error(`Server antwortet mit ${res.status}`);
      setPair(await res.json());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const copy = async () => {
    if (!pair) return;
    try {
      await navigator.clipboard.writeText(pair.url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <Card title="Zugang">
      <div class="small muted" style={{ marginBottom: 10 }}>
        Ein Kopplungslink meldet einen weiteren Browser (z. B. Bluefy) für 30 Tage an. Er ist 10 Minuten gültig und nur einmal verwendbar.
      </div>
      {err && <div class="note err" style={{ marginBottom: 10 }}>{err}</div>}
      {pair ? (
        <div class="stack">
          <input readOnly value={pair.url} onFocus={(e) => (e.target as HTMLInputElement).select()} />
          <button class="btn blue" onClick={copy}>{copied ? 'Kopiert ✓' : 'Link kopieren'}</button>
          <div class="small muted">Gültig bis {new Date(pair.expiresAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}</div>
        </div>
      ) : (
        <button class="btn" onClick={createPair}>Kopplungslink erstellen</button>
      )}
      <div class="btns" style={{ marginTop: 10 }}>
        <button
          class="btn danger"
          onClick={async () => {
            await fetch('/api/auth/logout', JSON_POST).catch(() => {});
            location.href = '/login';
          }}
        >
          Abmelden
        </button>
      </div>
    </Card>
  );
}

function NumField(props: { label: string; value: number; step?: number; onChange: (v: number) => void }) {
  return (
    <label class="field">
      <span>{props.label}</span>
      <input
        type="number" inputMode="decimal" step={props.step ?? 1} value={props.value}
        onInput={(e) => {
          const v = parseFloat((e.target as HTMLInputElement).value.replace(',', '.'));
          if (Number.isFinite(v)) props.onChange(v);
        }}
      />
    </label>
  );
}
