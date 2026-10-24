import { addDays, dateLabel, today } from '../format';

export function DayNav(props: { date: string; setDate: (d: string) => void }) {
  const isToday = props.date >= today();
  return (
    <div class="daynav">
      <button class="iconbtn" aria-label="Vorheriger Tag" onClick={() => props.setDate(addDays(props.date, -1))}>‹</button>
      <button class="label" style={{ background: 'none', border: 0, cursor: 'pointer' }} onClick={() => props.setDate(today())}>
        {dateLabel(props.date)}
      </button>
      <button class="iconbtn" aria-label="Nächster Tag" disabled={isToday} onClick={() => props.setDate(addDays(props.date, 1))}>›</button>
    </div>
  );
}
