# Lager-Scanner für SAP Business One

Web-App fürs Handy, mit der im Lager per Kamera, Bluetooth-/Hardware-Scanner oder Tastatur gescannt und direkt in **SAP Business One** gebucht wird. Sie läuft im Browser (Android/iPhone) und lässt sich als App auf den Startbildschirm legen. Ein App Store ist nicht nötig.

| Funktion | Was passiert in SAP B1 | Service-Layer-Objekt |
|---|---|---|
| 🔍 **Bestand** | Artikel/Barcode scannen → Bestand, reserviert, verfügbar je Lager | `Items`, `BarCodes` |
| 📦 **Kommissionieren** | Kundenauftrag scannen, Artikel abscannen → (Teil-)Lieferung mit Bezug zum Auftrag | `Orders` → `DeliveryNotes` |
| 📤 **Warenausgang** | Freie Entnahme aus einem Lager (Bemerkung, z. B. Kostenstelle) | `InventoryGenExits` |
| 🔁 **Umlagern** | Von Lager A nach Lager B | `StockTransfers` |
| 📋 **Inventur** | Gezählte Mengen erfassen → Inventurzählungs-Beleg (Differenzbuchung nach Prüfung im SAP-Client) | `InventoryCountings` |

## Aufbau

```
Handy (Browser/PWA)  ──HTTPS──▶  Lager-Scanner-Server (Node.js)  ──▶  SAP B1 Service Layer (:50000)
```

Das Handy spricht nie direkt mit SAP. Der kleine Server hält die SAP-Sitzung, prüft jede Buchung (Mengen, Lager, offene Auftragsmengen, Chargen-/Seriennummernpflicht) und lädt Aufträge vor dem Buchen neu aus SAP. Jeder Mitarbeiter meldet sich mit **seinem eigenen SAP-B1-Benutzer** an. Damit gelten seine SAP-Berechtigungen, und die Belege tragen seinen Namen.

## Schnellstart (Demo ohne SAP)

```bash
npm install
npm run dev          # Demo-Modus mit Testdaten auf http://localhost:3000
```

Anmeldung mit beliebigem Benutzer und Passwort. Testcodes: Barcode `4006381333931`, Artikel `A1000`, `B2000`, Kundenauftrag `10001`.

## Mit SAP Business One verbinden

1. Node.js ≥ 22.9 auf einem Server im Firmennetz installieren, der den Service Layer erreicht.
2. `.env.example` nach `.env` kopieren und ausfüllen:
   - `SAP_SL_URL`, z. B. `https://sap-b1:50000/b1s/v1/`
   - `SAP_COMPANY_DB`: die Firmendatenbank
   - `SAP_SL_CA`: CA-Zertifikat, falls der Service Layer ein selbst signiertes Zertifikat nutzt
3. `npm install && npm start`

### HTTPS ist Pflicht für die Kamera
Handy-Browser geben die Kamera nur über `https://` frei. Dafür gibt es zwei Wege:
- `TLS_CERT`/`TLS_KEY` in der `.env` setzen (Zertifikat für den Servernamen im Firmennetz), **oder**
- die App hinter einen vorhandenen Reverse-Proxy (IIS, nginx, Caddy) mit HTTPS stellen und `BEHIND_HTTPS_PROXY=1` setzen.

Bluetooth- oder Hardware-Scanner im Tastaturmodus (senden Code + Enter) funktionieren auch ohne HTTPS.

### Auf dem Handy installieren
Adresse im Browser öffnen, dann **„Zum Startbildschirm hinzufügen“** wählen (Chrome: Menü ⋮, Safari: Teilen-Symbol).

## Bekannte Grenzen (Version 0.1)
- **Chargen- und seriennummernpflichtige Artikel** werden erkannt und abgelehnt. Diese bitte im SAP-Client buchen.
- **Lagerplätze (Bin Locations)** werden noch nicht unterstützt. Gebucht wird auf Lagerebene.
- Kein Offline-Buchen: Ohne WLAN wird nicht gebucht. Erfasste Positionen bleiben als Entwurf auf dem Handy gespeichert.
- Mehrere Mengeneinheiten (UoM) pro Barcode werden nicht umgerechnet. Gebucht wird in der Lagermengeneinheit.

## Entwicklung
```bash
npm test     # API-Tests (Demo-Backend) + Tests des Service-Layer-Clients gegen nachgebauten Service Layer
```
