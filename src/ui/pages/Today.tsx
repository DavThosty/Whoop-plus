import { useState } from 'preact/hooks';
import type { ExplainKey } from '../../analytics';
import { app } from '../controller';
import { Card, LineChart, Ring, Stat } from '../components';
import { ExplainSheet } from '../explain';
import { clock, dateLabel, duration, durationShort, num, recoveryColor, today, ZONE_COLORS } from '../format';
import { useApp, useDay } from '../hooks';
import { DayNav } from './DayNav';

const linkBtn = { background: 'none', border: 0, padding: 0, cursor: 'pointer' } as const;

export function Today(props: { date: string; setDate: (d: string) => void; goTo: (tab: string) => void }) {
  const s = useApp();
  const day = useDay(props.date, s.dataVersion);
  const [topic, setTopic] = useState<ExplainKey | null>(null);
  const isToday = props.date === today();

  const rec = day?.recovery ?? null;
  const strain = day?.strain ?? null;
  const sleepPerf = day?.sleepPerformance ?? null;
  const zoneMax = Math.max(1, ...(day?.zoneMinutes ?? [0]));

  return (
    <div>
      <DayNav date={props.date} setDate={props.setDate} />

      {!s.profile && (
        <div class="note warn" style={{ marginBottom: 12 }}>
          Bitte zuerst dein{' '}
          <a href="#" onClick={(e) => { e.preventDefault(); props.goTo('profil'); }} style={{ color: 'var(--text)' }}>Profil</a>{' '}
          ausfüllen – ohne Alter, Gewicht und Maximalpuls lassen sich Strain und Kalorien nicht berechnen.
        </div>
      )}

      <div class="rings">
        <Ring
          label="Recovery" color={recoveryColor(rec)} fraction={rec == null ? null : rec / 100}
          value={rec == null ? '–' : `${rec}%`}
          sub={rec == null && day ? `Kalibrierung ${Math.min(day.baselineNights, 4)}/4` : undefined}
          onClick={() => setTopic('recovery')}
        />
        <Ring
          label="Strain" color="var(--blue)" fraction={strain == null ? null : strain / 21}
          value={strain == null ? '–' : num(strain, 1)} onClick={() => setTopic('strain')}
        />
        <Ring
          label="Schlaf" color="var(--sleep)" fraction={sleepPerf == null ? null : sleepPerf / 100}
          value={sleepPerf == null ? '–' : `${Math.round(sleepPerf)}%`}
          sub={day?.sleep ? `${durationShort(day.sleep.asleepMin)} h` : undefined}
          onClick={() => setTopic('sleep')}
        />
      </div>

      {day === null && (
        <div class="note" style={{ marginBottom: 12 }}>
          Für {dateLabel(props.date).toLowerCase() === 'heute' ? 'heute' : dateLabel(props.date)} gibt es noch keine Auswertung.
          {isToday && ' Verbinde dein Band im Tab „Band“, damit der Verlauf geladen wird.'}
        </div>
      )}

      {isToday && s.conn !== 'disconnected' && <LiveCard />}

      {day && (
        <Card title="Erholung">
          <div class="stats">
            <Stat value={num(day.sleep?.hrvRmssd)} unit="ms" label="HRV (RMSSD)" />
            <Stat value={num(day.sleep?.restingHr)} unit="bpm" label="Ruhepuls" />
            <Stat value={day.sleep ? clock(day.sleep.end) : '–'} label="Aufgewacht" />
          </div>
          <div class="row between small muted" style={{ marginTop: 10 }}>
            <button class="muted small" style={linkBtn} onClick={() => setTopic('hrv')}>ⓘ HRV</button>
            <button class="muted small" style={linkBtn} onClick={() => setTopic('restingHr')}>ⓘ Ruhepuls</button>
            <button class="muted small" style={linkBtn} onClick={() => props.goTo('schlaf')}>Schlaf-Details →</button>
          </div>
        </Card>
      )}

      {day && (
        <Card title={isToday ? 'Belastung bisher' : 'Belastung'} help={() => setTopic('strain')}>
          <div class="stats" style={{ marginBottom: 14 }}>
            <Stat value={num(day.kcal)} unit="kcal" label="Energie" />
            <Stat value={num(day.avgHr)} unit="bpm" label="Ø Puls wach" />
            <Stat value={num(day.maxHr)} unit="bpm" label="Max. Puls" />
          </div>
          <div class="zones">
            {day.zoneMinutes.map((m, i) => (
              <div class="zone" key={i}>
                <span class="muted">Zone {i + 1}</span>
                <div class="bar"><span style={{ width: `${(m / zoneMax) * 100}%`, background: ZONE_COLORS[i] }} /></div>
                <span style={{ textAlign: 'right' }}>{duration(m)}</span>
              </div>
            ))}
          </div>
          <div class="small muted" style={{ marginTop: 10 }}>
            Datenabdeckung {duration(day.coveredMin)} · berechnet {clock(day.computedAt / 1000)} ·{' '}
            <button class="muted small" style={{ ...linkBtn, textDecoration: 'underline' }} onClick={() => setTopic('calories')}>
              Kalorien?
            </button>
          </div>
        </Card>
      )}

      {topic && (
        <ExplainSheet
          topic={topic}
          onClose={() => setTopic(null)}
          extra={topic === 'recovery' && rec == null ? (
            <div class="note warn" style={{ marginBottom: 8 }}>
              Die Recovery braucht mindestens 4 Nächte mit HRV und Ruhepuls als Vergleichsbasis. Bisher: {day?.baselineNights ?? 0}.
            </div>
          ) : undefined}
        />
      )}
    </div>
  );
}

function LiveCard() {
  const s = useApp();
  const hr = s.live && s.live.hr > 0 ? s.live.hr : null;
  const busy = s.conn !== 'connected' && s.conn !== 'syncing';
  return (
    <Card title="Live-Puls">
      <div class="row between">
        <div class="live-hr">
          <span class="heart">♥</span>
          <span class="big">{hr ?? '–'}</span>
          <span class="muted">bpm</span>
        </div>
        <div style={{ width: 150 }}>
          <button class={`btn ${s.liveOn ? '' : 'blue'}`} onClick={() => app.setLive(!s.liveOn)} disabled={busy}>
            {s.liveOn ? 'Live stoppen' : 'Live starten'}
          </button>
        </div>
      </div>
      {s.live && !s.live.wearing && <div class="note warn" style={{ marginTop: 10 }}>Das Band wird gerade nicht getragen.</div>}
      {s.liveOn && (
        <div style={{ marginTop: 12 }}>
          <LineChart
            height={110}
            gap={10}
            series={[{ points: s.liveSeries.map((p) => ({ x: p.ts, y: p.hr })), color: 'var(--hr)', fill: true }]}
          />
          <div class="small muted">Letzte 10 Minuten</div>
        </div>
      )}
    </Card>
  );
}
