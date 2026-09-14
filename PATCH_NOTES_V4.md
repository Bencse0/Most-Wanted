# Most Wanted – V4 javítások

- A `MOST WANTED` státusz önmagában nem aktivál élő GPS-követést.
- Élő helyzetküldés csak aktív büntetés alatt engedélyezett, és ezt a backend is ellenőrzi.
- A Hunter felületén a Most Wanted játékos hivatalos utolsó pontja marad látható, nem az élő pont.
- A Menekülőnél a Vadász sebessége és a távolság csak a saját hivatalos helyzetjelzéskor rögzített pillanatképként frissül.
- A `/api/runner/updates` már nem számol újra dinamikus Vadász-távolságot minden pollingnál.
- A Vadász sebességét valódi GPS-pontok közötti mozgásból a szerver is képes kiszámolni, ha a böngésző `coords.speed` értéke nem használható.
- A Vadász böngészője csak új GPS-pozíció érkezésekor küld új pozíciót a szervernek.
- A büntetés legördülő menüjét az 1 másodperces állapotfrissítés nem építi újra a natív választó megnyitása közben.
- A szervizworker cache-verziója `most-wanted-v4`.
