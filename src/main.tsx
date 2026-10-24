import { render } from 'preact';
import { App } from './ui/App';
import './ui/styles.css';
import './ble/native-lifecycle';
import './native';

render(<App />, document.getElementById('app')!);
