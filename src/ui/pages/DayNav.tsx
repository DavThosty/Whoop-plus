import { Icon } from '../components';
import { addDays, dateLabel, today } from '../format';

export function DayNav(props: { date: string; setDate: (d: string) => void }) {
  const isToday = props.date >= today();
  return (
    <div class="glass row between" style={{ borderRadius: 999, padding: 5, marginBottom: 18 }}>
      <button class="circle-btn" style={{ width: 36, height: 36 }} aria-label="Vorheriger Tag" onClick={() => props.setDate(addDays(props.date, -1))}>
        <Icon name="chevL" />
      </button>
      <button style={{ background: 'none', border: 0, cursor: 'pointer', fontWeight: 700, fontSize: 15 }} onClick={() => props.setDate(today())}>
        {dateLabel(props.date)}
      </button>
      <button class="circle-btn" style={{ width: 36, height: 36, opacity: isToday ? 0.3 : 1 }} aria-label="Nächster Tag" disabled={isToday} onClick={() => props.setDate(addDays(props.date, 1))}>
        <Icon name="chevR" />
      </button>
    </div>
  );
}
