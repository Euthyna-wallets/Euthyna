# Notes for AI coding agents

## UI work

- The visual reference for the public site and the console is `design-handoff/`. Read `design-handoff/README.md` before changing any screen.
- For each screen, `screens/*.png` is the expected render and `source/*.html` gives the exact text and styles.
- The HTML files are static mockups: fixed width, example data, no API calls. Rebuild the look in the existing React components and keep their logic (routes, API calls, signatures).
- The current styling in `apps/console` (navy background, MandateOS logo) is being replaced. Do not copy it into new work.
- Blocks marked "à valider par Alex" in the handoff notes are not approved yet. Do not build them.
