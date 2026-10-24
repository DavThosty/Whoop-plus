import { EXPLANATIONS, type ExplainKey } from '../analytics';
import { Sheet } from './components';

export function ExplainSheet(props: { topic: ExplainKey; onClose: () => void; extra?: preact.ComponentChildren }) {
  const e = EXPLANATIONS[props.topic];
  return (
    <Sheet title={e.title} onClose={props.onClose}>
      {props.extra}
      {e.paragraphs.map((p, i) => <p key={i}>{p}</p>)}
      {e.formula && <pre>{e.formula}</pre>}
    </Sheet>
  );
}
