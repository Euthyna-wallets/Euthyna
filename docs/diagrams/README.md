# Diagrams

- `product.png`, `technical.png`: drawn by `blueprint.py` (SVG, site palette), rendered with
  Playwright. Font: IBM Plex Mono, installed locally.

  ```bash
  mkdir -p t && python3 blueprint.py t && node render.js technical product
  ```

- `payment.png`: Mermaid source `payment.mmd`, hand-drawn look (`style.json`):

  ```bash
  mmdc -i payment.mmd -o payment.png -c style.json -b white -s 2
  ```
