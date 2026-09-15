# Most Wanted v14 – 500 fix

- Reworked `/api/hunter/most-wanted` with defensive schema handling and explicit error stages.
- The endpoint now verifies that settings exist, validates runner id, checks active/cooldown state, and returns specific non-opaque error codes instead of a generic 500.
- Most Wanted 1m/90s and 2m/150s modes remain server-enforced.
- Most Wanted messaging and event logging remain part of the successful activation flow.
- PWA cache version bumped so the hunter client receives the current frontend.
