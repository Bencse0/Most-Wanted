# Most Wanted – Final fix

## Kritikus hibák javítva

- Az `/api/location` első hivatalos jelzése most már belépés után azonnal elküldhető.
- A régi Supabase/PostgreSQL sémához automatikus, indításkori migráció került (`server/schema.js`), ezért a korábbi hiányzó mezők nem okoznak többé 500-as hibát.
- A `/api/location` részletesen validálja a GPS-adatokat, és a szerver logolja a valódi PostgreSQL hibát.
- A `/api/runner/live-location` csak aktív büntetés alatt engedélyezett.
- A Most Wanted státusz önmagában NEM aktivál folyamatos Runner GPS-t.
- Normál Runner-jelzéskor egyszer kerül mentésre a Vadász sebessége és légvonalbeli távolsága.
- Most Wanted esetén a Hunter oldali sebesség/távolság snapshot a beállított hivatalos intervallum szerint frissül.
- A Runner nem kapja meg a Vadász adatainak folyamatos újraszámítását; csak a saját hivatalos jelének pillanatnyi snapshotját látja.
- Büntetés alatt a Runner külön live-location útvonalon küldi a GPS-t.
- Büntetés nélkül a Hunter csak a hivatalos utolsó Runner-pontot látja.
- A Hunter büntetés-selectje nem kerül újrarenderelésre a menü megnyitásakor, így a mobilos dropdown használható.
- A PWA Service Worker új cache-verziót kapott, és API-válaszokat nem cache-el.
- A frontend API-kérések `cache: no-store` módban futnak.

## Render + Supabase

A `DATABASE_URL` Render környezeti változóban maradjon a Supabase PostgreSQL connection stringje.

A `game.db` nem szükséges a production működéshez.


## Most Wanted metric-only live update

- A Most Wanted játékos pozíciója továbbra is kizárólag a normál `location_interval` szerint kerül elküldésre.
- A Most Wanted mód nem küld live GPS koordinátát, és a hunter térképén sem jelenik meg élő pozíció.
- A játékos saját eszközén a GPS-ből számolt sebesség és a hunter aktuális helyzete alapján számolt légvonalbeli távolság kerül periodikusan elküldésre a `live_update_interval` szerint.
- A hunter csak ezt a két származtatott értéket látja élőben, valamint az utolsó frissítés időpontját.
- A korábbi `/api/runner/live-location` végpont Most Wanted módban nem fogad pozíciót; az új `/api/runner/live-metrics` végpont kizárólag derived metrics adatot fogad.
