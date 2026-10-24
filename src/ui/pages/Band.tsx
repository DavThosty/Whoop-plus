import { useState } from 'preact/hooks';
import { app } from '../controller';
import { Card, Stat } from '../components';
import { dateTime, relative } from '../format';
import { useApp } from '../hooks';

export function Band() {
  const s = useApp();
  const [alarmTime, setAlarmTime] = useState('07:00');
  const [showLog, setShowLog] = useState(false);
  const connected = s.conn === 'connected' || s.conn === 'syncing';

  return (
    <div>
      {!s.supported && (
        <Card title="Bluetooth">
          <div class="note warn">
            Hier ist kein Bluetooth verfügbar. Whoop Plus ist für die iPhone-App gedacht; im Desktop-Browser
            funktioniert die Verbindung nur mit Web Bluetooth (z. B. Chrome).
          </div>
          <div class="btns" style={{ marginTop: 10 }}>
            <button class="btn" onClick={() => app.startDemo()}>Demo mit simuliertem Band starten</button>
          </div>
        </Card>
      )}

      {s.supported && (
        <Card title="Verbindung">
          <div class="row between" style={{ marginBottom: 12 }}>
            <div>
              <div style={{ fontWeight: 600 }}>{s.info?.name ?? 'Whoop 4.0'}{s.demo && ' (Demo)'}</div>
              <div class="small muted">{connLabel(s.conn)}</div>
            </div>
            {s.battery && <BatteryBadge percent={s.battery.percent} charging={s.battery.charging} />}
          </div>
          {s.error && (
            <div class="note err" style={{ marginBottom: 10 }} onClick={() => app.clearError()}>
              {s.error} <span class="muted small">(tippen zum Schließen)</span>
            </div>
          )}
          {s.conn === 'connecting' ? (
            <div class="btns two">
              <button class="btn primary" disabled>Verbinde …</button>
              <button class="btn" onClick={() => app.disconnect()}>Abbrechen</button>
            </div>
          ) : !connected ? (
            <button class="btn primary" onClick={() => app.connect()}>Band verbinden</button>
          ) : (
            <div class="btns two">
              <button class="btn blue" disabled={s.conn === 'syncing'} onClick={() => app.syncNow()}>
                {s.conn === 'syncing' ? 'Synchronisiere …' : 'Jetzt synchronisieren'}
              </button>
              <button class="btn" onClick={() => app.disconnect()}>Trennen</button>
            </div>
          )}
          {s.sync && !s.sync.done && (
            <div class="small muted" style={{ marginTop: 10 }}>
              {s.sync.records.toLocaleString('de-DE')} Datensätze empfangen
              {s.sync.newestTs && ` · bis ${dateTime(s.sync.newestTs)}`}
            </div>
          )}
          {s.computing && <div class="small muted" style={{ marginTop: 6 }}>Werte werden berechnet …</div>}
          <div class="small muted" style={{ marginTop: 10 }}>
            Letzter Sync: {s.lastSync ? relative(s.lastSync) : 'noch nie'}.
            {connected && ' Solange die App offen und verbunden ist, wird alle 15 Minuten automatisch synchronisiert.'}
          </div>
        </Card>
      )}

      {connected && (
        <Card title="Band">
          <div class="btns two">
            <button class="btn" onClick={() => app.buzz()}>Vibrieren</button>
            <button class="btn" onClick={() => app.setLive(!s.liveOn)}>{s.liveOn ? 'Live-Puls aus' : 'Live-Puls an'}</button>
          </div>
          <div style={{ marginTop: 14 }}>
            <div class="small muted" style={{ marginBottom: 6 }}>Vibrationswecker</div>
            {s.alarm ? (
              <div class="row">
                <div class="grow">Gestellt auf <b>{dateTime(s.alarm)}</b></div>
                <div style={{ width: 120 }}><button class="btn danger" onClick={() => app.setAlarm(null)}>Löschen</button></div>
              </div>
            ) : (
              <div class="row">
                <input type="time" value={alarmTime} onInput={(e) => setAlarmTime((e.target as HTMLInputElement).value)} />
                <div style={{ width: 120 }}>
                  <button class="btn" onClick={() => app.setAlarm(nextOccurrence(alarmTime))}>Stellen</button>
                </div>
              </div>
            )}
          </div>
          {s.info && (s.info.serial || s.info.firmware) && (
            <div class="small muted" style={{ marginTop: 12 }}>
              {s.info.serial && <>Seriennummer {s.info.serial}<br /></>}
              {s.info.firmware && <>Firmware {s.info.firmware}</>}
            </div>
          )}
        </Card>
      )}

      <Card title="Gespeicherte Daten">
        <div class="stats">
          <Stat value={(s.stats?.count ?? 0).toLocaleString('de-DE')} label="Datensätze" />
          <Stat value={s.stats?.oldest ? new Date(s.stats.oldest * 1000).toLocaleDateString('de-DE', { day: 'numeric', month: 'short' }) : '–'} label="Ältester" />
          <Stat value={s.stats?.newest ? new Date(s.stats.newest * 1000).toLocaleDateString('de-DE', { day: 'numeric', month: 'short' }) : '–'} label="Neuester" />
        </div>
        <div class="small muted" style={{ marginTop: 10 }}>
          Alles bleibt lokal auf diesem iPhone. Das Band speichert ungefähr 14 Tage – synchronisiere also spätestens alle paar Tage.
          {s.storage && <> Belegt: {(s.storage.usage / 1e6).toLocaleString('de-DE', { maximumFractionDigits: 0 })} MB.</>}
        </div>
        {s.storage && s.storage.persisted !== true && (
          <div class="note warn" style={{ marginTop: 10 }}>
            Der Browser garantiert keine dauerhafte Speicherung. Exportiere regelmäßig eine Sicherung.
          </div>
        )}
        <div class="btns two" style={{ marginTop: 10 }}>
          <button class="btn" onClick={() => app.exportData()}>Sicherung exportieren</button>
          <label class="btn" style={{ cursor: 'pointer' }}>
            Sicherung einspielen
            <input
              type="file" accept="application/json,.json" style={{ display: 'none' }}
              onChange={(e) => {
                const f = (e.target as HTMLInputElement).files?.[0];
                if (f) void app.importData(f);
                (e.target as HTMLInputElement).value = '';
              }}
            />
          </label>
        </div>
      </Card>

      <Card title="Vor dem ersten Verbinden">
        <ol class="steps">
          <li>Offizielle Whoop-App löschen oder zumindest beenden – das Band lässt nur eine Verbindung zu.</li>
          <li>iOS-Einstellungen → Bluetooth → bei „WHOOP …“ auf ⓘ → „Dieses Gerät ignorieren“.</li>
          <li>Band aufladen und anlegen, dann hier „Band verbinden“ tippen und das Band auswählen.</li>
          <li>Beim ersten Mal fragt iOS nach der Kopplung – bestätigen. Ohne Kopplung ignoriert das Band alle Befehle.</li>
          <li>Zum Synchronisieren die App kurz öffnen – sie verbindet sich dann selbst mit dem Band. Im Hintergrund kann iOS die App jederzeit pausieren.</li>
        </ol>
      </Card>

      <Card title="Protokoll">
        <button class="btn" onClick={() => setShowLog(!showLog)}>{showLog ? 'Ausblenden' : `Anzeigen (${s.log.length})`}</button>
        {showLog && <div class="log" style={{ marginTop: 10 }}>{s.log.length ? s.log.join('\n') : 'Noch keine Einträge.'}</div>}
      </Card>
    </div>
  );
}

function BatteryBadge(props: { percent: number; charging?: boolean }) {
  const p = Math.round(props.percent);
  const color = p <= 15 ? 'var(--red)' : p <= 30 ? 'var(--yellow)' : 'var(--green)';
  return (
    <span class="pill">
      <span style={{ color }}>{props.charging ? '⚡' : '▮'}</span>
      {p}%
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
