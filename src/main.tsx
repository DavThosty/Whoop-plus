import { render } from 'preact';
import { App } from './ui/App';
import './ui/styles.css';
import './ble/native-lifecycle';

render(<App />, document.getElementById('app')!);
