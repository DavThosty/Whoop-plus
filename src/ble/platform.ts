// Wählt die Bluetooth-Schicht: native iOS-App → Capacitor-Plugin, sonst Web Bluetooth (Desktop-Browser, `npm run dev`).
import { Capacitor } from '@capacitor/core';
import { createCapacitorBluetooth, type CapacitorBluetooth } from './capacitor-bluetooth';

let native: CapacitorBluetooth | null = null;

export function isNativeApp(): boolean {
  return Capacitor.isNativePlatform();
}

/** Bluetooth-Objekt in Web-Bluetooth-Form, oder `undefined`, wenn es keins gibt. */
export function platformBluetooth(): Bluetooth | undefined {
  if (isNativeApp()) return (native ??= createCapacitorBluetooth());
  return (globalThis as { navigator?: Navigator }).navigator?.bluetooth ?? undefined;
}
