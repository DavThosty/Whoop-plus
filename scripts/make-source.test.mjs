import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BUNDLE_ID, DEFAULT_CHANGELOG, MAX_CHANGELOG, RELEASE_DOWNLOAD, cleanChangelog, computeVersion, ipaName, isoDate, makeMeta, makeSource, releaseAssetName,
} from './make-source.mjs';

const SCRIPT = new URL('./make-source.mjs', import.meta.url).pathname;

describe('Versionsnummern', () => {
  it('major.minor aus package.json, Patch und Build = Lauf-Nummer', () => {
    expect(computeVersion('0.1.0', '12')).toEqual({ marketing: '0.1.12', build: '12' });
    expect(computeVersion('1.4.7-beta.1', 305)).toEqual({ marketing: '1.4.305', build: '305' });
  });
  it('lehnt Unsinn ab', () => {
    expect(() => computeVersion('abc', '1')).toThrow();
    expect(() => computeVersion('0.1.0', '')).toThrow();
    expect(() => computeVersion('0.1.0', '1a')).toThrow();
  });
  it('CLI schreibt GITHUB_OUTPUT-Zeilen', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const [maj, min] = pkg.version.split('.');
    expect(execFileSync('node', [SCRIPT, 'version', '42'], { encoding: 'utf8' })).toBe(`marketing=${maj}.${min}.42\nbuild=42\n`);
  });
});

describe('„Was ist neu“ aus der Commit-Nachricht', () => {
  it('Squash-Merge: Titel ohne PR-Nummer, Trailer und Bot-Zeilen weg, Markdown vereinfacht', () => {
    const msg = [
      'Redesign „Glow & Glas“: Morgen-Story und Workout-Modus (#3)',
      '',
      '## Was sich ändert',
      '',
      '* **Morgen-Story** nach dem Aufwachen',
      '- Workout-Modus mit `Live-Puls`',
      '- [x] Details in [der Anleitung](https://example.com/doc)',
      '',
      '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
      '',
      'https://claude.ai/code/session_011hKyGUgMNnKHCnyLoQvjYZ',
      '',
      'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>',
      'Claude-Session: https://claude.ai/code/session_011hKyGUgMNnKHCnyLoQvjYZ',
      'Signed-off-by: Someone <a@b.c>',
    ].join('\n');
    expect(cleanChangelog(msg)).toBe(
      [
        'Redesign „Glow & Glas“: Morgen-Story und Workout-Modus',
        '',
        'Was sich ändert',
        '',
        '• Morgen-Story nach dem Aufwachen',
        '• Workout-Modus mit Live-Puls',
        '• Details in der Anleitung',
      ].join('\n'),
    );
  });

  it('klassischer Merge-Commit: „Merge pull request …“ fällt weg, Codeblöcke und Kommentare auch', () => {
    const msg = 'Merge pull request #7 from DavThosty/claude/fix\n\nSync stabiler\n\n```\nnpm test\n```\n<!-- intern -->\n| a | b |\n|---|---|\n| 1 | 2 |';
    expect(cleanChangelog(msg)).toBe('Sync stabiler\n\na – b\n1 – 2');
  });

  it('kürzt lange Texte an einer Wortgrenze mit „…“', () => {
    const long = `Titel\n\n${'Wort '.repeat(300)}`;
    const out = cleanChangelog(long);
    expect(out.length).toBeLessThanOrEqual(MAX_CHANGELOG);
    expect(out.endsWith('Wort…')).toBe(true);
  });

  it('snake_case und Sternchen in Wörtern bleiben stehen', () => {
    expect(cleanChangelog('Fix für sample_bounds und 2*3')).toBe('Fix für sample_bounds und 2*3');
    expect(cleanChangelog('Ein *kursives* Wort und _noch_ eins')).toBe('Ein kursives Wort und noch eins');
  });

  it('leer bzw. nur Trailer → leer; die CLI nimmt dann den Standardtext', () => {
    expect(cleanChangelog('')).toBe('');
    expect(cleanChangelog('Co-Authored-By: X <x@y.z>\n')).toBe('');
    expect(execFileSync('node', [SCRIPT, 'changelog'], { input: 'Co-Authored-By: X <x@y.z>\n', encoding: 'utf8' })).toBe(DEFAULT_CHANGELOG);
    expect(execFileSync('node', [SCRIPT, 'changelog'], { input: 'Neu: Wecker (#9)\n\nClaude-Session: x\n', encoding: 'utf8' })).toBe('Neu: Wecker');
  });
});

describe('source.json', () => {
  const base = { version: '0.1.12', build: '12', changelog: 'Neu: Wecker', size: 1234, sha256: 'ABCDEF', date: '2026-10-24T10:00:00Z', minOSVersion: '15.0' };

  it('Datum ohne Millisekunden (SideStore-Format)', () => {
    expect(isoDate(new Date('2026-10-24T10:11:12.345Z'))).toBe('2026-10-24T10:11:12Z');
  });

  it('hat die Felder des AltStore-Quellformats', () => {
    const { source, removedAssets } = makeSource({ ...base, privacy: { NSBluetoothAlwaysUsageDescription: 'Bluetooth' } });
    expect(removedAssets).toEqual([]);
    expect(source).toMatchObject({ name: 'Whoop Plus', identifier: `${BUNDLE_ID}.source`, tintColor: '#16ec06' });
    expect(source.iconURL).toMatch(/^https:\/\/raw\.githubusercontent\.com\/.+\.png$/);
    const app = source.apps[0];
    expect(app).toMatchObject({ name: 'Whoop Plus', bundleIdentifier: BUNDLE_ID, developerName: 'DavThosty' });
    expect(app.localizedDescription).toContain('WHOOP');
    expect(app).not.toHaveProperty('marketplaceID'); // sonst hält SideStore die Quelle für „notarisiert“ und blockiert sie
    expect(app.appPermissions).toEqual({ entitlements: [], privacy: { NSBluetoothAlwaysUsageDescription: 'Bluetooth' } });
    expect(app.versions).toEqual([
      {
        version: '0.1.12',
        buildVersion: '12',
        date: '2026-10-24T10:00:00Z',
        localizedDescription: 'Neu: Wecker',
        downloadURL: `${RELEASE_DOWNLOAD}WhoopPlus-0.1.12.ipa`,
        size: 1234,
        sha256: 'abcdef',
        minOSVersion: '15.0',
      },
    ]);
  });

  it('leerer Changelog → Standardtext', () => {
    expect(makeSource({ ...base, changelog: '  ' }).source.apps[0].versions[0].localizedDescription).toBe(DEFAULT_CHANGELOG);
  });

  it('neue Version vorne, alte bleiben, gleiche Version wird ersetzt, ab 10 wird gekürzt', () => {
    let prev = null;
    const removed = [];
    for (let n = 1; n <= 12; n++) {
      const r = makeSource({ ...base, version: `0.1.${n}`, build: String(n), previous: prev });
      prev = JSON.parse(JSON.stringify(r.source));
      removed.push(...r.removedAssets);
    }
    const versions = prev.apps[0].versions.map((v) => v.version);
    expect(versions).toEqual(['0.1.12', '0.1.11', '0.1.10', '0.1.9', '0.1.8', '0.1.7', '0.1.6', '0.1.5', '0.1.4', '0.1.3']);
    expect(removed).toEqual(['WhoopPlus-0.1.1.ipa', 'WhoopPlus-0.1.2.ipa']);
    // Erneuter Lauf derselben Version (z. B. „Re-run“): ersetzt statt doppelt.
    const again = makeSource({ ...base, version: '0.1.12', build: '12', changelog: 'neu', previous: prev });
    expect(again.source.apps[0].versions.filter((v) => v.version === '0.1.12')).toHaveLength(1);
    expect(again.source.apps[0].versions[0].localizedDescription).toBe('neu');
    expect(again.removedAssets).toEqual([]);
  });

  it('kaputte oder fremde vorherige Quelle schadet nicht; fremde URLs werden nie gelöscht', () => {
    expect(makeSource({ ...base, previous: { apps: 'x' } }).source.apps[0].versions).toHaveLength(1);
    const prev = { apps: [{ bundleIdentifier: BUNDLE_ID, versions: [{ version: '0.0.1', downloadURL: 'https://example.com/a.ipa' }, null] }] };
    const r = makeSource({ ...base, previous: prev, keep: 1 });
    expect(r.source.apps[0].versions).toHaveLength(1);
    expect(r.removedAssets).toEqual([]);
    expect(releaseAssetName(`${RELEASE_DOWNLOAD}WhoopPlus-0.1.3.ipa`)).toBe('WhoopPlus-0.1.3.ipa');
    expect(releaseAssetName('https://example.com/x.ipa')).toBeNull();
    expect(ipaName('0.1.3')).toBe('WhoopPlus-0.1.3.ipa');
  });

  it('CLI: liest Meta + IPA, schreibt source.json und die Liste der zu löschenden Assets', () => {
    const dir = mkdtempSync(join(tmpdir(), 'src-'));
    const ipa = join(dir, 'WhoopPlus-0.1.12.ipa');
    writeFileSync(ipa, 'IPA-Inhalt');
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({ version: '0.1.12', build: '12', changelog: 'Neu', minOSVersion: '15.0', privacy: { NSBluetoothAlwaysUsageDescription: 'BT' } }));
    execFileSync('node', [SCRIPT, 'source', '--meta', join(dir, 'meta.json'), '--ipa', ipa, '--previous', join(dir, 'fehlt.json'), '--out', join(dir, 'source.json'), '--removed', join(dir, 'removed.txt')]);
    const s = JSON.parse(readFileSync(join(dir, 'source.json'), 'utf8'));
    const v = s.apps[0].versions[0];
    expect(v.size).toBe(Buffer.byteLength('IPA-Inhalt'));
    expect(v.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(v.date).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(readFileSync(join(dir, 'removed.txt'), 'utf8')).toBe('');
  });
});

describe('Metadaten aus dem gebauten Info.plist', () => {
  const info = {
    CFBundleIdentifier: BUNDLE_ID, CFBundleShortVersionString: '0.1.12', CFBundleVersion: '12', MinimumOSVersion: '15.0',
    NSBluetoothAlwaysUsageDescription: 'Bluetooth', UIBackgroundModes: ['bluetooth-central'],
  };
  it('übernimmt minOSVersion und Datenschutz-Texte', () => {
    expect(makeMeta(info, { version: '0.1.12', build: '12', changelog: ' Neu \n' })).toEqual({
      version: '0.1.12', build: '12', changelog: 'Neu', minOSVersion: '15.0', privacy: { NSBluetoothAlwaysUsageDescription: 'Bluetooth' },
    });
    expect(makeMeta(info, { version: '0.1.12', build: '12', changelog: '' }).changelog).toBe(DEFAULT_CHANGELOG);
  });
  it('bricht ab, wenn Version, Build oder Bundle-ID nicht passen (SideStore würde ablehnen)', () => {
    expect(() => makeMeta({ ...info, CFBundleShortVersionString: '1.0' }, { version: '0.1.12', build: '12' })).toThrow();
    expect(() => makeMeta({ ...info, CFBundleVersion: '1' }, { version: '0.1.12', build: '12' })).toThrow();
    expect(() => makeMeta({ ...info, CFBundleIdentifier: 'x' }, { version: '0.1.12', build: '12' })).toThrow();
  });
  it('CLI schreibt release-meta.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'meta-'));
    writeFileSync(join(dir, 'info.json'), JSON.stringify(info));
    writeFileSync(join(dir, 'cl.txt'), 'Neu: Wecker');
    execFileSync('node', [SCRIPT, 'meta', '--info', join(dir, 'info.json'), '--changelog', join(dir, 'cl.txt'), '--version', '0.1.12', '--build', '12', '--out', join(dir, 'm.json')]);
    expect(JSON.parse(readFileSync(join(dir, 'm.json'), 'utf8')).changelog).toBe('Neu: Wecker');
  });
});
