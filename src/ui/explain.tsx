import { EXPLANATIONS, type ExplainKey } from '../analytics';
import { Sheet } from './components';

export function ExplainSheet(props: { topic: ExplainKey; onClose: () => void; extra?: preact.ComponentChildren }) {
  const e = EXPLANATIONS[props.topic];
  return (
    <Sheet title={e.title} onClose={props.onClose}>
      {props.extra}
      {e.paragraphs.map((p, i) => <p key={i}>{p}</p>)}
      {e.formula && <pre>{e.formula}</pre>}
      {e.limitations.length > 0 && (
        <>
          <div class="eyebrow" style={{ marginTop: 16 }}>Grenzen</div>
          <ul>{e.limitations.map((l, i) => <li key={i}>{l}</li>)}</ul>
        </>
      )}
    </Sheet>
  );
}
