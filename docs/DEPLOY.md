# Whoop-plus deployen (VPS · Portainer · Nginx Proxy Manager)

Diese Anleitung bringt Whoop-plus auf **https://whoop.steiner-kn.de**. Der Server liefert nur die
App aus und sorgt für die Anmeldung. **Alle Gesundheitsdaten bleiben im Browser auf dem iPhone**
(IndexedDB in Bluefy). Auf dem Server liegen nur die Passkey-Daten und der Schlüssel für die Sitzungen.

So läuft der Zugriff:

```
iPhone (Safari / Bluefy) ──HTTPS──▶ Nginx Proxy Manager ──HTTP, Docker-Netz──▶ whoop-plus:8080
```

- Der Container `whoop-plus` gibt **keine Ports** auf dem Host frei. Docker würde ufw sonst umgehen.
  NPM erreicht ihn nur über ein gemeinsames Docker-Netzwerk.
- Einmalig registrierst du einen **Passkey** (Face ID). Danach ist die Registrierung dauerhaft geschlossen.
- Bluefy kann meist keine Passkeys. Darum meldest du dich in Safari an und erzeugst dort einen
  **Kopplungs-Link**. Den öffnest du in Bluefy. Bluefy bleibt dann 30 Tage angemeldet.

---

## 1. DNS-Eintrag

Lege beim DNS-Anbieter von `steiner-kn.de` einen Eintrag an:

| Typ | Name    | Wert                | TTL  |
|-----|---------|---------------------|------|
| A   | `whoop` | öffentliche IPv4 des VPS | 300 |

Hat der VPS auch IPv6 und NPM lauscht dort, kommt ein `AAAA`-Eintrag dazu. Prüfe den Eintrag:

```sh
dig +short whoop.steiner-kn.de
```

Die Ausgabe muss die VPS-IP zeigen. Erst dann klappt das Let's-Encrypt-Zertifikat in Schritt 4.

## 2. GitHub-Token für Portainer (nur Lesezugriff)

Das Repo `davthosty/whoop-plus` ist privat. Portainer braucht daher einen Token:

1. GitHub → Profilbild → **Settings** → **Developer settings** → **Personal access tokens** →
   **Fine-grained tokens** → **Generate new token**.
2. **Token name:** `portainer-whoop-plus`. Bei **Expiration** z. B. 1 Jahr wählen. Notiere dir das Ablaufdatum.
3. **Resource owner:** `davthosty`.
4. **Repository access:** *Only select repositories* → `davthosty/whoop-plus`.
5. **Permissions** → *Repository permissions* → **Contents: Read-only**.
   *Metadata: Read-only* setzt GitHub automatisch. Mehr Rechte braucht der Token nicht.
6. **Generate token**. Kopiere den Token (`github_pat_…`) sofort, er wird nur einmal angezeigt.

## 3. Stack in Portainer anlegen

### 3a. Netzwerk von Nginx Proxy Manager herausfinden

Der Container muss im selben Docker-Netzwerk wie NPM hängen.

- Portainer → **Containers** → NPM-Container (z. B. `nginx-proxy-manager` oder `npm-app-1`) öffnen.
  Ganz unten unter **Connected networks** steht der Netzwerkname.
  Häufig ist das `npm_default` oder `nginx-proxy-manager_default`.
- Alternativ per SSH: `docker inspect -f '{{json .NetworkSettings.Networks}}' <npm-container>`

**Empfehlung: ein eigenes Netzwerk nur für NPM und whoop-plus.** Der Server vertraut dem
`X-Forwarded-For`-Header des direkt vorgeschalteten Proxys (`TRUST_PROXY=1`). Er nutzt die IP für die
Begrenzung von Fehlversuchen. Hängt whoop-plus im allgemeinen NPM-Netzwerk, können auch andere
Container dort Anfragen mit gefälschter IP schicken und so die Begrenzung umgehen. Deshalb:

1. Portainer → **Networks** → **Add network**, Name `whoop-proxy`, Driver `bridge` → **Create**.
2. NPM-Container öffnen → **Connected networks** → *Join a network* → `whoop-proxy` → **Join network**.
   NPM bleibt zusätzlich in seinen bisherigen Netzwerken, andere Proxy Hosts laufen also weiter.
3. Im nächsten Schritt `PROXY_NETWORK=whoop-proxy` setzen. Sonst hängt niemand in diesem Netzwerk.

Das ist auch der Weg, wenn NPM nur im Netzwerk `bridge` hängt (dort geht keine Namensauflösung).
Willst du es einfacher, geht auch das vorhandene NPM-Netzwerk (z. B. `npm_default`).

### 3b. Stack erstellen

Portainer → **Stacks** → **+ Add stack**:

| Feld | Wert |
|------|------|
| Name | `whoop-plus` |
| Build method | **Repository** |
| Repository URL | `https://github.com/davthosty/whoop-plus` |
| Repository reference | `refs/heads/main` |
| Compose path | `docker-compose.yml` |
| Authentication | **an**. Username: `davthosty`, Personal Access Token: der Token aus Schritt 2 |
| GitOps updates | aus (Updates manuell, siehe Schritt 8) |

Unter **Environment variables** → *Add an environment variable*:

| Variable | Wert | Pflicht? |
|----------|------|----------|
| `PROXY_NETWORK` | Netzwerkname aus 3a, empfohlen `whoop-proxy` | **ja**, falls nicht `npm_default` |
| `RP_ID` | `whoop.steiner-kn.de` | nein (Standard) |
| `ORIGIN` | `https://whoop.steiner-kn.de` | nein (Standard) |
| `SESSION_DAYS` | `30` | nein (Standard) |
| `TRUST_PROXY` | `1` (genau ein Proxy davor: NPM) | nein (Standard) |
| `SETUP_CODE` | eigener Setup-Code statt Zufallscode | nein |
| `RESET_AUTH` | **nicht setzen**. Nur zum Zurücksetzen, siehe Schritt 7 | nein |

Dann **Deploy the stack**. Portainer klont das Repo und baut das Image:
Frontend mit Vite, dann den Node-Server. Der erste Build dauert ein paar Minuten.

Zum Prüfen: **Containers** → `whoop-plus` sollte nach etwa 30 Sekunden *healthy* sein.
Die Daten liegen im Volume `whoop-plus_whoop-data`. Es übersteht Redeploys.

## 4. Proxy Host in Nginx Proxy Manager

NPM-Oberfläche → **Hosts** → **Proxy Hosts** → **Add Proxy Host**

**Tab „Details“:**

| Feld | Wert |
|------|------|
| Domain Names | `whoop.steiner-kn.de` |
| Scheme | `http` |
| Forward Hostname / IP | `whoop-plus` (der Containername) |
| Forward Port | `8080` |
| Cache Assets | **aus**. Wichtig: Die App liegt hinter dem Login und darf nicht im Proxy gecacht werden. |
| Block Common Exploits | an |
| Websockets Support | egal (wird nicht benutzt) |

**Tab „SSL“:**

- SSL Certificate: **Request a new SSL Certificate**
- **Force SSL**: an
- **HTTP/2 Support**: an
- **HSTS Enabled**: an. Die App sendet HSTS auch selbst, doppelt schadet nicht.
- E-Mail eintragen, den Let's-Encrypt-Bedingungen zustimmen → **Save**

Danach öffnest du `https://whoop.steiner-kn.de`. Du solltest auf `/login` mit „Ersteinrichtung“ landen.

## 5. Ersteinrichtung: Passkey in Safari registrieren

1. Portainer → **Containers** → `whoop-plus` → **Logs**. Dort steht ein Kasten wie dieser:

   ```
   ================================================================
     WHOOP-PLUS ERSTEINRICHTUNG – noch kein Passkey registriert

     SETUP-CODE:  K7QM-2XRP-H9TA-4WNC
   ================================================================
   ```

   Ohne diesen Code kann niemand einen Passkey anlegen, auch kein Fremder, der die Seite vor dir öffnet.
   Groß- und Kleinschreibung, Leerzeichen und Bindestriche sind egal. Nach 5 falschen Versuchen ist
   die Eingabe 15 Minuten gesperrt.
   Hast du `SETUP_CODE` gesetzt, gilt dein eigener Code. Er wird dann nicht ins Log geschrieben.
   Der Zufallscode ändert sich bei jedem Neustart, solange noch kein Passkey registriert ist.
2. Öffne auf dem iPhone in **Safari** `https://whoop.steiner-kn.de`.
3. Code eingeben → **Passkey erstellen** → mit Face ID bestätigen.
   Der Passkey landet im iCloud-Schlüsselbund.
4. Fertig. Im Log steht jetzt: *„Passkey registriert. Die Registrierung ist jetzt dauerhaft GESCHLOSSEN.“*
   Ab jetzt sieht jeder andere nur noch die Anmeldeseite.

## 6. Bluefy koppeln

Safari kann kein Web Bluetooth. Darum zeigt die Seite nach der Anmeldung in Safari **„Bluefy koppeln“**:

1. In Safari auf **Kopplungs-Link erstellen** tippen → **Kopieren**.
2. **Bluefy** öffnen.
3. Den Link in die Adresszeile einfügen und öffnen.
4. Bluefy landet direkt in der App und ist **30 Tage** angemeldet.

Gut zu wissen:

- Der Link gilt **10 Minuten** und funktioniert **nur einmal**. Er ist wie ein Schlüssel: nicht weitergeben.
- Läuft die Sitzung in Bluefy ab, zeigt Bluefy die Anmeldeseite mit einem Hinweis.
  Dann meldest du dich in Safari mit dem Passkey an, erzeugst einen neuen Link und fügst ihn in Bluefy ein.
- Die Kopplungsseite erreichst du in Safari jederzeit über `https://whoop.steiner-kn.de/login`.
- Kopplungs-Links lassen sich **nur nach einer Anmeldung mit dem Passkey** erstellen. Eine Sitzung,
  die selbst über einen Kopplungs-Link entstanden ist (Bluefy), kann keine neuen Links erzeugen.
  So kann ein gestohlenes Bluefy-Cookie sich nicht endlos verlängern.
- **Achtung:** Die Messdaten liegen nur in Bluefy (IndexedDB). Löschst du die Website-Daten von Bluefy
  oder Bluefy selbst, sind die Daten weg. Nutze den Export der App, falls vorhanden.

## 7. Zurücksetzen (Handy verloren oder neues Gerät)

Beim Zurücksetzen werden **alle Passkeys gelöscht**. **Alle Sitzungen und offenen Kopplungs-Links**
werden ungültig, auch die auf einem verlorenen Handy. Danach ist die Ersteinrichtung wieder offen,
wie in Schritt 5.

**Variante A: Konsole (empfohlen)**

- Portainer → **Containers** → `whoop-plus` → **Console** → Command `/bin/sh`, **User `node`** →
  **Connect**, dann:

  ```sh
  node server/reset.js
  ```

- Oder per SSH auf dem VPS:

  ```sh
  docker exec -u node whoop-plus node server/reset.js
  ```

Danach öffnest du die Login-Seite einmal oder startest den Container neu. Den **neuen Setup-Code**
liest du wie in Schritt 5 aus den Logs ab.

**Variante B: Umgebungsvariable**

1. Portainer → **Stacks** → `whoop-plus` → **Editor** → Environment variables → `RESET_AUTH` = `1` →
   **Update the stack**.
2. Im Log steht eine Warnung mit „!!!!“ und darunter der neue Setup-Code. Richte den Passkey neu ein (Schritt 5).
3. **Wichtig:** Entferne `RESET_AUTH` danach wieder und aktualisiere den Stack.
   Sonst wird bei **jedem** Neustart erneut zurückgesetzt.

Danach den alten Passkey auf dem iPhone löschen: **Einstellungen → Passwörter** (bzw. App
„Passwörter“) → `whoop.steiner-kn.de` → alten Passkey löschen. Er funktioniert nach dem Reset nicht mehr.

## 8. Updates einspielen

1. Änderungen nach `main` pushen.
2. Portainer → **Stacks** → `whoop-plus` → **Pull and redeploy** (bzw. *Redeploy* im Git-Bereich) → bestätigen.

Portainer holt den neuen Stand und baut das Image neu. In der Compose-Datei steht `pull_policy: build`,
deshalb wird bei jedem Deploy gebaut. Passkey, Sitzungen und Setup-Status liegen im Volume
`whoop-plus_whoop-data` und bleiben erhalten. Du musst dich nach einem Update nicht neu anmelden.

Optional kannst du **GitOps updates** (Polling, z. B. alle 5 Minuten) einschalten.
Dann deployt Portainer jeden Push auf `main` automatisch.

## 9. Fehlersuche

| Symptom | Ursache / Lösung |
|---------|------------------|
| **502 Bad Gateway** von NPM | NPM erreicht den Container nicht. Prüfe: Hängen NPM und `whoop-plus` im selben Netzwerk (`PROXY_NETWORK`, Schritt 3a)? Ist der Forward Hostname genau `whoop-plus` und der Port `8080`? Ist das Scheme `http` (nicht https)? Ist der Container *healthy*? |
| Stack-Deploy schlägt fehl: *network … not found* | `PROXY_NETWORK` stimmt nicht. Den Namen exakt aus Portainer → Networks übernehmen. |
| Build schlägt fehl | Portainer zeigt die Build-Ausgabe beim Deploy. Meist ein Fehler im Frontend-Build (`npm run build`). Prüfe vorher lokal mit `npm ci && npm run build`. |
| Passkey: *„Sicherheitsfehler“*, *„The operation is insecure“*, Verifikation fehlgeschlagen | `RP_ID` bzw. `ORIGIN` passen nicht zur aufgerufenen Adresse. Es muss genau `RP_ID=whoop.steiner-kn.de` und `ORIGIN=https://whoop.steiner-kn.de` sein (ohne `/` am Ende) und die Seite muss über diese Adresse per HTTPS geöffnet werden. |
| Passkey-Dialog erscheint in Bluefy nicht oder bricht ab | Normal. Bluefy darf auf iOS meist keine Passkeys nutzen. Nimm den Kopplungs-Link (Schritt 6). |
| *„Setup-Code ist falsch“* | Den aktuellen Code aus dem Log nehmen. Er ändert sich bei jedem Neustart, solange nichts registriert ist. Nach 5 Fehlversuchen 15 Minuten warten. |
| Nach erfolgreicher Anmeldung wieder auf `/login` (Login-Schleife), Cookie wird nicht gesetzt | Das Sitzungs-Cookie ist `Secure` (Präfix `__Host-`) und wird nur über HTTPS gespeichert. In NPM muss *Force SSL* an sein, die Seite muss über `https://whoop.steiner-kn.de` aufgerufen werden (nicht über IP oder `http://`), und `COOKIE_SECURE` darf nicht gesetzt sein. Hilft das nicht: In Safari *Einstellungen → Safari → Erweitert → Website-Daten* die Daten von `whoop.steiner-kn.de` löschen und neu anmelden. (`TRUST_PROXY` hat damit nichts zu tun. Es bestimmt nur, welche Client-IP für die Begrenzung von Fehlversuchen gilt.) |
| Alle Nutzer teilen sich die Fehlversuchs-Sperre bzw. *„Zu viele Anfragen“* kommt sofort | `TRUST_PROXY` passt nicht zur Proxy-Kette: Bei genau einem Proxy (NPM) muss es `1` sein, mit einem weiteren Proxy davor (z. B. Cloudflare) `2`. |
| *„Kopplungs-Link ist ungültig“* | Der Link ist älter als 10 Minuten, wurde schon benutzt, oder seitdem wurde zurückgesetzt. Erzeuge in Safari einen neuen Link. |
| *„App ist nicht gebaut (index.html fehlt)“* | Das Frontend fehlt im Image. Der Build ist unvollständig. Neu deployen und die Build-Ausgabe prüfen. |
| *„Zu viele Anfragen“* | Es gibt einen Schutz gegen Durchprobieren (60 Auth-Anfragen pro Minute und IP). Kurz warten. |
| Setup-Code nicht im Log sichtbar | Ist schon ein Passkey registriert, gibt es keinen Code. Neu einrichten geht nur über Schritt 7. |

## Anhang

### Alle Umgebungsvariablen

| Variable | Standard | Bedeutung |
|----------|----------|-----------|
| `RP_ID` | `whoop.steiner-kn.de` | WebAuthn Relying-Party-ID (Domain ohne `https://`) |
| `ORIGIN` | `https://whoop.steiner-kn.de` | Öffentliche Adresse. Wird für Passkeys und Kopplungs-Links benutzt. |
| `PORT` | `8080` | Interner Port des Containers. Bei Änderung auch in NPM anpassen. |
| `DATA_DIR` | `/data` | Speicherort für `auth.json` (Passkeys, Generation) und `session.key` |
| `SESSION_DAYS` | `30` | Gültigkeit einer Sitzung in Tagen |
| `SETUP_CODE` | zufällig | Fester Setup-Code für die Ersteinrichtung |
| `RESET_AUTH` | leer | `1`: beim Start alles zurücksetzen (danach wieder entfernen!) |
| `TRUST_PROXY` | `1` | Anzahl vertrauenswürdiger Proxys davor (Express `trust proxy`). Bestimmt nur die Client-IP für die Begrenzung von Fehlversuchen. |
| `PROXY_NETWORK` | `npm_default` | Nur Compose: Docker-Netzwerk, das whoop-plus mit NPM teilt (empfohlen: eigenes Netzwerk `whoop-proxy`) |
| `SESSION_SECRET` | automatisch | Optional, mindestens 32 Zeichen. Sonst wird ein Schlüssel in `DATA_DIR/session.key` erzeugt. |

### Lokal testen (Entwicklung)

```sh
npm ci && npm run build
npm ci --prefix server
DATA_DIR=./data COOKIE_SECURE=0 ORIGIN=http://localhost:8080 RP_ID=localhost node server/index.js
npm test --prefix server   # Server-Tests
```

`COOKIE_SECURE=0` ist nur für `http://localhost` gedacht und darf **nie** in Produktion gesetzt werden.
