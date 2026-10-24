import { useEffect, useState } from 'preact/hooks';
import type { ExplainKey } from '../../analytics';
import { wipeAll } from '../../store/db';
import type { Profile } from '../../types';
import { GlassCard, Icon, Stat } from '../components';
import { app } from '../controller';
import { ExplainSheet } from '../explain';
import { dateTime, relative } from '../format';
import { useApp, useStore, useWorkouts } from '../hooks';
import { workout } from '../workout';
import { FirstSteps } from './Today';

const TOPICS: { key: ExplainKey; label: string; color: string; icon: string }[] = [
  { key: 'recovery', label: 'Recovery', color: '#16ec06', icon: 'today' },
  { key: 'strain', label: 'Strain', color: '#0093e7', icon: 'bolt' },
  { key: 'sleep', label: 'Schlaf', color: '#8db4d2', icon: 'moon' },
  { key: 'hrv', label: 'HRV', color: '#16ec06', icon: 'wave' },
  { key: 'restingHr', label: 'Ruhepuls', color: '#ff4d6d', icon: 'heart' },
  { key: 'calories', label: 'Kalorien', color: '#ff9f0a', icon: 'flame' },
];

export function More() {
  const [topic, setTopic] = useState<ExplainKey | null>(null);
  return (
    <div>
      <div class="section-label">Band</div>
      <BandSection />
      <div class="section-label">Profil</div>
      <ProfileSection />
      <div class="section-label">Daten</div>
      <DataSection />
      <div class="section-label">Zugang</div>
      <AccountSection />
      <div class="section-label">Wie wird gerechnet?</div>
      <section class="glass list">
        {TOPICS.map((t) => (
          <button key={t.key} class="list-row" onClick={() => setTopic(t.key)}>
            <span class="ico" style={{ background: `${t.color}22`, color: t.color }}><Icon name={t.icon} /></span>
            <span class="grow">{t.label}</span>
            <Icon name="chevR" class="chev" />
          </button>
        ))}
      </section>
      <div class="section-label">Protokoll</div>
      <LogSection />
      <div class="center faint tiny" style={{ marginTop: 24 }}>Whoop Plus · alle Daten bleiben auf diesem Gerät</div>
      {topic && <ExplainSheet topic={topic} onClose={() => setTopic(null)} />}
    </div>
  );
}

function BandSection() {
  const s = useApp();
  const [alarmTime, setAlarmTime] = useState('07:00');
  const [steps, setSteps] = useState(false);
  const connected = s.conn === 'connected' || s.conn === 'syncing';

  if (!s.supported) {
    return (
      <GlassCard>
        <div class="note warn">
          Dieser Browser kann kein Bluetooth. Öffne die App auf dem iPhone in <b>Bluefy</b> (kostenlos im App Store). Safari unterstützt Web Bluetooth nicht.
        </div>
        <div class="btns" style={{ marginTop: 12 }}>
          <button class="btn primary" onClick={() => app.startDemo()}><Icon name="play" /> Demo starten</button>
        </div>
      </GlassCard>
    );
  }

  return (
    <>
      <GlassCard>
        <div class="row" style={{ marginBottom: 16 }}>
          <span class="ico" style={{ width: 48, height: 48, borderRadius: 15, display: 'grid', placeItems: 'center', background: connected ? 'rgba(22,236,6,0.12)' : 'rgba(255,255,255,0.06)', color: connected ? 'var(--green)' : 'var(--text-2)' }}>
            <Icon name="band" size={24} />
          </span>
          <div class="grow">
            <div style={{ fontWeight: 700, fontSize: 17 }}>{s.info?.name ?? 'Whoop 4.0'}{s.demo && ' (Demo)'}</div>
            <div class="small muted">{connLabel(s.conn)}{s.postSync || s.computing ? ' · berechne …' : ''}</div>
          </div>
          {s.battery && <BatteryBadge percent={s.battery.percent} charging={s.battery.charging} />}
        </div>
        {s.error && (
          <button class="note err" style={{ display: 'block', width: '100%', textAlign: 'left', marginBottom: 12, cursor: 'pointer' }} onClick={() => app.clearError()}>
            {s.error} <span class="faint small">(tippen zum Schließen)</span>
          </button>
        )}
        {s.conn === 'connecting' ? (
          <div class="btns two">
            <button class="btn primary" disabled>Verbinde …</button>
            <button class="btn" onClick={() => app.disconnect()}>Abbrechen</button>
          </div>
        ) : !connected ? (
          <button class="btn primary" onClick={() => app.connect()}><Icon name="band" /> Band verbinden</button>
        ) : (
          <div class="btns two">
            <button class="btn blue" disabled={s.conn === 'syncing'} onClick={() => app.syncNow()}>
              <Icon name="sync" /> {s.conn === 'syncing' ? 'Synchronisiere …' : 'Jetzt syncen'}
            </button>
            <button class="btn" onClick={() => app.disconnect()}>Trennen</button>
          </div>
        )}
        {s.sync && !s.sync.done && (
          <div class="small muted" style={{ marginTop: 12 }}>
            {s.sync.records.toLocaleString('de-DE')} Datensätze empfangen
            {s.sync.newestTs && ` · bis ${dateTime(s.sync.newestTs)}`}
          </div>
        )}
        {s.computing && <div class="small muted" style={{ marginTop: 6 }}>Werte werden berechnet …</div>}
        <div class="small faint" style={{ marginTop: 12 }}>
          Letzter Sync: {s.lastSync ? relative(s.lastSync) : 'noch nie'}.
          {connected && ' Solange die App offen und verbunden ist, wird alle 15 Minuten automatisch synchronisiert.'}
        </div>
      </GlassCard>

      {connected && (
        <GlassCard title="Steuerung">
          <div class="btns two">
            <button class="btn" onClick={() => app.buzz()}><Icon name="vibrate" /> Vibrieren</button>
            <button class="btn" onClick={() => app.setLive(!s.liveOn)}><Icon name="heart" /> {s.liveOn ? 'Live-Puls aus' : 'Live-Puls an'}</button>
          </div>
          <div style={{ marginTop: 16 }}>
            <div class="small muted" style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}><Icon name="alarm" size={15} /> Vibrationswecker</div>
            {s.alarm ? (
              <div class="row">
                <div class="grow">Gestellt auf <b>{dateTime(s.alarm)}</b></div>
                <button class="btn small danger" onClick={() => app.setAlarm(null)}>Löschen</button>
              </div>
            ) : (
              <div class="row">
                <input type="time" value={alarmTime} onInput={(e) => setAlarmTime((e.target as HTMLInputElement).value)} style={{ flex: 1 }} />
                <button class="btn small" style={{ minHeight: 48 }} onClick={() => app.setAlarm(nextOccurrence(alarmTime))}>Stellen</button>
              </div>
            )}
          </div>
          {s.info && (s.info.serial || s.info.firmware) && (
            <div class="small faint" style={{ marginTop: 14 }}>
              {s.info.serial && <>Seriennummer {s.info.serial}<br /></>}
              {s.info.firmware && <>Firmware {s.info.firmware}</>}
            </div>
          )}
        </GlassCard>
      )}

      <section class="glass list" style={{ marginBottom: 12 }}>
        <button class="list-row" onClick={() => setSteps(!steps)} aria-expanded={steps}>
          <span class="ico" style={{ background: 'rgba(255,255,255,0.07)' }}><Icon name="info" /></span>
          <span class="grow">Vor dem ersten Verbinden</span>
          <Icon name={steps ? 'chevD' : 'chevR'} class="chev" />
        </button>
        {steps && <div style={{ padding: '6px 18px 18px' }}><FirstSteps /></div>}
      </section>
    </>
  );
}

function ProfileSection() {
  const s = useApp();
  const [p, setP] = useState<Profile>(s.profile ?? { age: 30, weightKg: 75, sex: 'm', maxHr: 190, sleepNeedH: 8 });
  const [maxTouched, setMaxTouched] = useState(!!s.profile);
  const [saved, setSaved] = useState(false);

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
    <GlassCard>
      {!s.profile && <div class="note warn" style={{ marginBottom: 14 }}>Noch kein Profil gespeichert – bitte ausfüllen.</div>}
      <div class="form-grid">
        <NumField label="Alter (Jahre)" value={p.age} onChange={(v) => update({ age: v })} />
        <NumField label="Gewicht (kg)" value={p.weightKg} step={0.5} onChange={(v) => update({ weightKg: v })} />
        <NumField label={`Maximalpuls (Vorschl. ${220 - p.age})`} value={p.maxHr} onChange={(v) => { setMaxTouched(true); update({ maxHr: v }); }} />
        <NumField label="Schlafbedarf (h)" value={p.sleepNeedH} step={0.25} onChange={(v) => update({ sleepNeedH: v })} />
      </div>
      <div style={{ marginTop: 14 }}>
        <span class="small muted" style={{ display: 'block', marginBottom: 6, fontSize: 12, fontWeight: 600 }}>Geschlecht (für die Kalorienformel)</span>
        <div class="seg">
          <button class={p.sex === 'm' ? 'on' : ''} onClick={() => update({ sex: 'm' })}>Männlich</button>
          <button class={p.sex === 'w' ? 'on' : ''} onClick={() => update({ sex: 'w' })}>Weiblich</button>
        </div>
      </div>
      <div class="small faint" style={{ marginTop: 12 }}>
        Der Maximalpuls bestimmt die Pulszonen und damit den Strain. Kennst du deinen echten Maximalpuls (z. B. aus einem Belastungstest), trag ihn ein – das ist genauer als 220 − Alter.
      </div>
      <div style={{ marginTop: 14 }}>
        <button class="btn primary" disabled={!valid || s.computing} onClick={async () => { await app.saveProfile(p); setSaved(true); }}>
          {saved ? <><Icon name="check" /> Gespeichert</> : 'Speichern & neu berechnen'}
        </button>
      </div>
    </GlassCard>
  );
}

function DataSection() {
  const s = useApp();
  const w = useStore(workout);
  const workouts = useWorkouts(w.version);
  const fmt = (ts: number | null | undefined) => (ts ? new Date(ts * 1000).toLocaleDateString('de-DE', { day: 'numeric', month: 'short' }) : '–');
  return (
    <GlassCard>
      <div class="stats">
        <Stat value={(s.stats?.count ?? 0).toLocaleString('de-DE')} label="Datensätze" />
        <Stat value={fmt(s.stats?.oldest)} label="Ältester" />
        <Stat value={fmt(s.stats?.newest)} label="Neuester" />
      </div>
      <div class="stats two" style={{ marginTop: 8 }}>
        <Stat value={workouts == null ? '–' : String(workouts.length)} label="Workouts" />
        <Stat value={s.storage ? `${(s.storage.usage / 1e6).toLocaleString('de-DE', { maximumFractionDigits: 0 })}` : '–'} unit="MB" label="Belegt" />
      </div>
      <div class="small faint" style={{ marginTop: 12 }}>
        Alles bleibt lokal auf diesem iPhone. Das Band speichert ungefähr 14 Tage – synchronisiere also spätestens alle paar Tage.
      </div>
      {s.storage && s.storage.persisted !== true && (
        <div class="note warn" style={{ marginTop: 12 }}>
          Der Browser garantiert keine dauerhafte Speicherung. Exportiere regelmäßig eine Sicherung.
        </div>
      )}
      <div class="btns two" style={{ marginTop: 14 }}>
        <button class="btn" onClick={() => app.exportData()}>Sicherung exportieren</button>
        <label class="btn" style={{ cursor: 'pointer' }}>
          Sicherung einspielen
          <input
            type="file" accept="application/json,.json" style={{ display: 'none' }}
            onChange={(e) => {
              const f = (e.target as HTMLInputElement).files?.[0];
              if (f) void app.importData(f).then(() => workout.bumpVersion());
              (e.target as HTMLInputElement).value = '';
            }}
          />
        </label>
      </div>
      <label class="field" style={{ marginTop: 16 }}>
        <span>Rohdaten aufbewahren (Tageswerte bleiben immer)</span>
        <select value={String(s.retentionDays)} onChange={(e) => app.setRetention(Number((e.target as HTMLSelectElement).value))}>
          <option value="0">Unbegrenzt</option>
          <option value="30">30 Tage</option>
          <option value="90">90 Tage</option>
          <option value="365">1 Jahr</option>
        </select>
      </label>
      <div class="btns" style={{ marginTop: 12 }}>
        <button class="btn" disabled={s.computing} onClick={() => app.recomputeAll()}>
          <Icon name="sync" /> {s.computing ? 'Berechne …' : 'Alle Tage neu berechnen'}
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
          <Icon name="trash" /> Alle Daten löschen
        </button>
      </div>
    </GlassCard>
  );
}

// Der Server akzeptiert POST-Anfragen an /api nur als JSON (CSRF-Schutz).
const JSON_POST: RequestInit = {
  method: 'POST',
  credentials: 'same-origin',
  headers: { 'Content-Type': 'application/json' },
  body: '{}',
};

function AccountSection() {
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
    <GlassCard>
      <div class="small muted" style={{ marginBottom: 12 }}>
        Ein Kopplungslink meldet einen weiteren Browser (z. B. Bluefy) für 30 Tage an. Er ist 10 Minuten gültig und nur einmal verwendbar.
      </div>
      {err && <div class="note err" style={{ marginBottom: 12 }}>{err}</div>}
      {pair ? (
        <div class="stack">
          <input readOnly value={pair.url} onFocus={(e) => (e.target as HTMLInputElement).select()} />
          <button class="btn blue" onClick={copy}>{copied ? <><Icon name="check" /> Kopiert</> : 'Link kopieren'}</button>
          <div class="small faint">Gültig bis {new Date(pair.expiresAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}</div>
        </div>
      ) : (
        <button class="btn" onClick={createPair}><Icon name="key" /> Kopplungslink erstellen</button>
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
    </GlassCard>
  );
}

function LogSection() {
  const s = useApp();
  const [show, setShow] = useState(false);
  return (
    <section class="glass list">
      <button class="list-row" onClick={() => setShow(!show)} aria-expanded={show}>
        <span class="ico" style={{ background: 'rgba(255,255,255,0.07)' }}><Icon name="terminal" /></span>
        <span class="grow">{show ? 'Protokoll ausblenden' : 'Protokoll anzeigen'}</span>
        <span class="val">{s.log.length}</span>
        <Icon name={show ? 'chevD' : 'chevR'} class="chev" />
      </button>
      {show && <div style={{ padding: '4px 14px 14px' }}><div class="log">{s.log.length ? s.log.join('\n') : 'Noch keine Einträge.'}</div></div>}
    </section>
  );
}

function BatteryBadge(props: { percent: number; charging?: boolean }) {
  const p = Math.round(props.percent);
  const color = p <= 15 ? 'var(--red)' : p <= 30 ? 'var(--yellow)' : 'var(--green)';
  return (
    <span class="pill" style={{ cursor: 'default' }}>
      <span style={{ color, display: 'inline-flex' }}>{props.charging ? <Icon name="bolt" size={14} /> : <Icon name="battery" size={16} />}</span>
      {p} %
    </span>
  );
}

function connLabel(c: string): string {
  return { disconnected: 'Nicht verbunden', connecting: 'Verbinde …', connected: 'Verbunden', syncing: 'Synchronisiere …' }[c] ?? c;
}

function nextOccurrence(hhmm: string): Date {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return d;
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
