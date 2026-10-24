import { useEffect, useState } from 'preact/hooks';
import { app } from './controller';
import { today } from './format';
import { useApp } from './hooks';
import { Band } from './pages/Band';
import { ProfilePage } from './pages/ProfilePage';
import { Sleep } from './pages/Sleep';
import { Today } from './pages/Today';
import { Trends } from './pages/Trends';

type Tab = 'heute' | 'schlaf' | 'trends' | 'band' | 'profil';

const TABS: { id: Tab; label: string; icon: preact.JSX.Element }[] = [
  { id: 'heute', label: 'Heute', icon: <path d="M12 3a9 9 0 1 0 9 9M12 7a5 5 0 1 0 5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" /> },
  { id: 'schlaf', label: 'Schlaf', icon: <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" /> },
  { id: 'trends', label: 'Trends', icon: <path d="M4 19V10M10 19V5M16 19v-7M22 19H2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" /> },
  { id: 'band', label: 'Band', icon: <path d="M8 3h8l1 4v10l-1 4H8l-1-4V7l1-4Zm-1 6h10M7 15h10" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" /> },
  { id: 'profil', label: 'Profil', icon: <path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-8 9a8 8 0 0 1 16 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" /> },
];

const TITLES: Record<Tab, string> = { heute: 'Übersicht', schlaf: 'Schlaf', trends: 'Trends', band: 'Band', profil: 'Profil' };

export function App() {
  const s = useApp();
  const [tab, setTab] = useState<Tab>(() => (location.hash.slice(1) as Tab) || 'heute');
  const [date, setDate] = useState(today());

  useEffect(() => {
    void app.init();
  }, []);

  useEffect(() => {
    history.replaceState(null, '', `${location.pathname}${location.search}#${tab}`);
    window.scrollTo(0, 0);
  }, [tab]);

  // Ohne Profil zuerst ins Profil; ohne Verbindung und ohne Daten zum Band.
  useEffect(() => {
    if (location.hash) return;
    if (s.stats && s.stats.count === 0 && !s.demo) setTab(s.profile ? 'band' : 'profil');
  }, [s.stats?.count, s.profile]);

  const goTo = (t: string) => setTab(t as Tab);

  return (
    <div class="app">
      <header class="topbar">
        <h1>{TITLES[tab]}</h1>
        <button class="pill" style={{ cursor: 'pointer' }} onClick={() => setTab('band')}>
          <span class={`dot ${s.conn === 'connected' ? 'on' : s.conn === 'disconnected' ? '' : 'busy'}`} />
          {s.conn === 'connected' ? (s.battery ? `${Math.round(s.battery.percent)}%` : 'Verbunden') : s.conn === 'syncing' ? 'Sync …' : s.conn === 'connecting' ? 'Verbinde …' : 'Getrennt'}
        </button>
      </header>

      {tab === 'heute' && <Today date={date} setDate={setDate} goTo={goTo} />}
      {tab === 'schlaf' && <Sleep date={date} setDate={setDate} />}
      {tab === 'trends' && <Trends />}
      {tab === 'band' && <Band />}
      {tab === 'profil' && <ProfilePage />}

      <nav class="tabbar">
        {TABS.map((t) => (
          <button key={t.id} class={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)} aria-current={tab === t.id ? 'page' : undefined}>
            <svg viewBox="0 0 24 24">{t.icon}</svg>
            {t.label}
          </button>
        ))}
      </nav>
    </div>
  );
}
