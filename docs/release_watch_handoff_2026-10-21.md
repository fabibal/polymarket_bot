# Átadás Claude-nak — release-watch javítások, 2026-10-21

A felhasználó kérésére a Codex-review javaslatai megvalósultak. A cél a
végrehajthatóság mérésének javítása; a rendszer továbbra is DRY_RUN. A release-watch
semmilyen megbízást nem ír alá vagy küld be.

**Mi változott**

1. **A hash-változás nem indít profitszámítást.** Külön marad a `firstChange`,
   a `firstMarker` és az eseményenkénti `firstValidated`. K az utóbbi `at`
   időpontja: a megfelelő időszak adatának beolvasása és kiértékelése után.
   Az általános BEA-index és az RSS/Atom feed csak megjelenésfigyelő;
   egy GDP-frissítés nem indíthat PCE-értékelést.
2. **Determinista számkiolvasás.** CPI headline/core MoM/YoY; payroll és
   unemployment; JOLTS Table 1 szezonálisan igazított, ezres pontosságú Total;
   GDP advance estimate; core PCE MoM/YoY; Fed változás és explicit számszerű
   szavazatarány. Ismeretlen formátum, rossz időszak, kétértelmű sáv vagy hiányzó
   szám nem ad kereskedési jelzést. A BEA-nál a teljes közleményt is figyeljük,
   GDP-nél a termékoldalról követett hivatalos hivatkozással tartalékolva.
3. **Visszanézhető bizonyíték.** Minden különböző letöltött válasz tömörítve
   megmarad a `bodies/<forrás>/<sha256>.html.gz` alatt; a szám, mértékegység,
   bizonyító szöveg, forrás URL, idő és fájlhivatkozás összekapcsolható.
4. **A tokenválasztás az akkor kiolvasott számból történik.** A Gamma előzetesen
   rögzített sávfeliratai/szabályai alapján pontosan egy YES és a többi NO
   választható. Nem a később ismert nyertesekből válogat a stratégia.
5. **Teljes könyvellenőrzés.** Mindkét oldal minden ára és mennyisége számít.
   Fontos tényleges API-viselkedés: a REST/kezdeti WS könyv időbélyege az utolsó
   változás ideje, nem a kérés kiszolgálásáé. Az új REST-ellenőrzés a hozzá
   tartozó HTTP-kérés t0–t1 ablakában lehetséges teljes WS-állapotokat hasonlítja.
   A régi, kérésidő nélküli formátum időbélyeg alapján diagnosztizálható.
6. **Kapcsolatvesztés kezelése.** A napló kapcsolat-epochokat, open/close/error,
   stale és stop eseményeket, valamint PONG-okat is tartalmaz. Megszakadás után
   tokenenként új teljes könyv kell; 20 másodpercnyi kapcsolatcsend mellett a
   régi könyv nem használható. A kezdeti könyv kora nem hálózati késésminta.
7. **Egy közös $800-os keret.** Díjakkal együtt, minden egyidejű eseményre.
   A tervezés a döntésig megérkezett könyvből indul; a későbbi könyv csak a már
   kiválasztott, árkorlátos megbízás teljesülését korlátozhatja. Figyelembe veszi
   a minimum kötésméretet, tick size-t, pénzlekötést és a részleges teljesülést.
   Az olcsóbb árszinteket piacok között is előre sorolja.
8. **Érzékenységi riport.** 0/250/500/1000/2000/5000 ms késés,
   100/50/25% feltételezett megszerezhető mennyiség, 0,90/0,95/0,99 árkorlát,
   FAK, továbbá néhány FOK összehasonlítás. Ezek feltételezések, nem mért
   teljesülési valószínűségek. A REST-olvasási RTT kizárólag diagnosztika.
9. **Nincs árfolyam alapú nyertesbecslés.** Lezárást csak `closed=true`,
   `umaResolutionStatus=resolved` és pontos bináris 1/0 kifizetés igazol.
   Addig `confirmedNet=null`; a `netIfCorrect` külön, feltételes szám.
   Rosszul kiolvasott jel a későbbi lezárás ellen értékelve veszteséget mutathat.
   Hibás/hiányos adatnál az eredmény `null`, nem nulla profit vagy sikertörténet.
10. **Cron-burkoló.** `flock`, futásonként külön könyvtár, latest mutató,
    kérésenkénti timeout, 15 perces külső korlát és kényszerleállítási tartalék,
    saját konténerek takarítása. Hibás gyermekfolyamat vagy rossz/hiányzó
    minőségösszegzés nem zárul sikerrel. A Telegram hibája nem teszi tönkre a
    mérést. Egy normál befejezett futás egy értesítést küld; `RW_NOTIFY=0`
    letiltja az értesítést és a közös titkok beolvasását is.
11. **Másolóbot.** Olvashatatlan könyvnél `book_unavailable` kihagyás történik;
    a jel feldolgozottnak jelölt, később nem másolja újra régi áron. A nyers
    trader_history megmarad. A meglevő `no_asks` és mélységkorlát is megmarad.
12. **Történeti PnL elkülönítése.** Új `executionEvidence` mező az `/api/stats`
    és az `/api/watchlist` → `sinceReset` alatt. A dashboard külön kártyán mutatja
    a belépéskori könyvvel dokumentált lezárt másolatok nettóját és az ebből
    kizárt, hiányzó/utólag visszatöltött könyvű sorokat. A történeti adatbázist
    és a régi összesítő/risk számításokat nem írtuk át. A dokumentált részhalmaz
    is szimuláció, nem bizonyított tényleges teljesülés.

**Fájlok**

- `scripts/release_watch.js`: adatgyűjtés, timeout, kapcsolat- és payloadnapló.
- `scripts/release_watch_config.js`: dátumok, források, esemény → mérőszám.
- `scripts/release_watch_parsers.js`: közleményolvasók és sávszabályok.
- `scripts/release_watch_model.js`: könyv-visszajátszás, validáció, közös pénzkeret.
- `scripts/release_watch_report.js`: lezárásellenőrzés, v2 JSON és szöveges riport.
- `scripts/release-watch.sh`: működési burkoló.
- `src/monitor.ts`, `src/execution_evidence.ts`, `src/dashboard.ts`,
  `public/index.html`: kihagyási szabály és PnL-bizonyíték szerinti bontás.
- `tests/release_watch.test.ts`, `tests/release_watch_wrapper.check.cjs`,
  `tests/execution_evidence.test.ts`, `tests/fixtures/release-watch/`,
  valamint az érintett meglévő monitor-tesztek.
- `CLAUDE.md`, `docs/decisions.md`, `docs/KNOWN_ISSUES.md`: állapot és döntések.

**Futtatás**

Az öt meglévő UTC cron időpontját nem módosítottam. Az első továbbra is
2026-10-28 17:57 UTC, azaz 18:57 Budapest. A futó wrapper az új host-fájlokat
használja. Új adatútvonal:

```
logs/release-watch/<release-id>/<run-id>/
logs/release-watch/<release-id>/latest
```

A `latest` az utolsó indítást jelöli, akkor is, ha az hibás volt; nem rejti el
az új hibát egy korábbi sikeres futással. Régi tesztkönyvtárakat nem töröltünk.
A v2 riport a régi `report.json` helyett `report-v2.json`-t ír.

A lezárás után, a projekt gyökeréből:

```bash
docker run --rm -u 1000:1000 --network container:gluetun \
  -v "$PWD":/app:ro -v "$PWD/logs/release-watch":/out \
  node:20-alpine node /app/scripts/release_watch_report.js fomc-2026-10-28
```

Az azonosító után opcionálisan megadható a konkrét run-id. `--offline` mellett
nincs Gamma-lekérés; korábbi `resolution-v2.json` hiányában a kifizetés nem
igazolt. A régi, hash-alapú futások csak diagnosztikát adnak, `INVALID` állapottal.

**Ellenőrzés és korlátok**

- Teljes, hálózat nélküli Alpine tesztcsomag: 232/232 teszt sikeres.
  Ezután egy új offline riport-CLI teszt is hozzáadásra került; a release-watch
  tesztfájl végső külön futása 40/40 sikeres.
- Host shell-ellenőrzés: 6/6 sikeres, helyi Docker/curl utánzatokkal.
  Lefedi a gyermekfolyamat-hibát, rossz minőséget, VPN-kiesést, párhuzamos
  indítást, külön futáskönyvtárakat és Telegram-hibát.
- A számolvasók valódi, korábbi hivatalos közlemények helyi másolatain futnak;
  van rossz dátum/időszak, negatív érték és félrevezető lábléc teszt is.
- Helyi HTTP-próba igazolta a változás → számkiolvasás → tömörített bizonyíték
  folyamatot; nincs hozzá külső adatküldés.
- Az öt tervezett közlés összesen 93 piaca feloldható; a próbákban minden
  esemény sávja/tokenje kijelölhető volt, a szükséges díj/minimum/tick adatok
  hiánytalanok voltak. Ez a mostani metaadatokra vonatkozik.
- Valódi, kizárólag olvasó CLOB-próba: 10 token, 3 REST-pillanatfelvétel,
  az időbélyeg-kezelés javítása után 30/30 teljes könyvegyezés. Nyers adat:
  `logs/release-watch-validation/book-1792582971518/`.
- A régi `test-b` adatoknál a szigorú ellenőrzés az ismert 296/304 teljes
  egyezést találta meg a 304/304 legjobbár-egyezés mögött.
- TypeScript `--noEmit`, JavaScript/shell szintaxis és diff whitespace ellenőrzés
  sikeres. Nem ment tesztüzenet valódi Telegram-csatornára.

A parserek szándékosan szűkek: új hivatalos szövegformátumhoz új fixture és
ellenőrzött módosítás kell. A Fed szavazatszámát jelenleg explicit számszerű
szavazatarányból olvassuk; eltérő, neveket felsoroló formátumból nem találgatunk.
Nincs mért valódi fill rate, order-latency vagy megbízásunkra adott piaci reakció.
A szerver-, finanszírozási és beváltási fix költségek külön maradnak.
A másolóbot korábbi méretezési/kilépési/threshold-resolution korlátait ez a
munkamenet nem javította meg; a könyvvel dokumentált PnL sem certifikált nyereség.
Néhány közlés a megvalósíthatóság vizsgálatához elég, tartós előny igazolásához nem.

**Üzembe helyezés**

A botot `docker compose up -d --no-deps --build bot` paranccsal újraépítettem és
újraindítottam; a gluetun nem lett újraindítva. Ellenőrizve: `DRY_RUN=true`,
a 8082-es dashboard és `/api/stats` HTTP 200, VPN státusz `ok`, az új PnL-kártya
és API-mező elérhető. A release-watch cron a hostról már az új fájlokat indítja.

Az ellenőrzés pillanatában a reset utáni lezárt watchlist-részhalmaz:
66 belépéskori könyvvel dokumentált másolat **−$13,26** nettó szimulált PnL;
22 ilyen bizonyíték nélküli másolat **+$13,23**, amely kimarad az új dokumentált
részösszegből. Ez időpillanatnyi, szimulált bontás, nem új stratégiai backtest.

Az új függőségeket és a saját változtatásokat stagingbe vettem, hogy a napi
`git-sync.sh` az új modulokat se hagyja ki. Commitot és pusht nem indítottam.
A `docs/decisions.md` korábbi munkamenetek módosításait is tartalmazza, ezért
annak vegyes változásait nem tettem stagingbe. Az új döntésbejegyzés és a régi
release-watch bejegyzés felülírásának jelölése ott megtalálható. A korábban már
létező, más témájú két review dokumentum és a `tests/lowfreq_scan.test.ts`
érintetlen maradt.
