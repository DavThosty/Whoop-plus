// Datei aus der nativen App teilen: im WKWebView funktioniert `a.download` nicht. Die Datei wird daher
// in den Cache-Ordner der App geschrieben und über das iOS-Teilen-Menü angeboten (Dateien, AirDrop, Mail …).
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

/** Blockgröße für das Schreiben: große Sicherungen nicht als einen riesigen String über die Bridge schicken. */
const CHUNK_BYTES = 2 * 1024 * 1024;

/** Schreibt einen Blob blockweise als UTF-8-Text in eine Datei; liefert deren URI. */
export async function writeBlobChunked(blob: Blob, path: string, directory: Directory): Promise<string> {
  const decoder = new TextDecoder();
  let uri: string | null = null;
  for (let off = 0; off < blob.size || uri === null; off += CHUNK_BYTES) {
    const end = Math.min(off + CHUNK_BYTES, blob.size);
    // stream: true – ein UTF-8-Zeichen kann über eine Blockgrenze reichen.
    const text = decoder.decode(await blob.slice(off, end).arrayBuffer(), { stream: end < blob.size });
    if (uri === null) {
      uri = (await Filesystem.writeFile({ path, data: text, directory, encoding: Encoding.UTF8, recursive: true })).uri;
    } else {
      await Filesystem.appendFile({ path, data: text, directory, encoding: Encoding.UTF8 });
    }
  }
  return uri;
}

export async function shareFileNative(blob: Blob, name: string, title: string): Promise<void> {
  const uri = await writeBlobChunked(blob, `export/${name}`, Directory.Cache);
  try {
    await Share.share({ title, files: [uri], dialogTitle: title });
  } catch (e) {
    // Schließen des Teilen-Menüs ist kein Fehler.
    if (/cancel/i.test(e instanceof Error ? e.message : String(e))) return;
    throw e;
  }
}
