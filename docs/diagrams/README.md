# Diagrams

- `product.png`, `technical.png`: drawn by `tiles.py` (SVG), rendered with
  Playwright. Fonts: Comic Shanns, installed locally.

  ```bash
  mkdir -p t && python3 tiles.py t && node render.js technical product
  ```

- `payment.png`: Mermaid source `payment.mmd`, hand-drawn look (`style.json`):

  ```bash
  mmdc -i payment.mmd -o payment.png -c style.json -b white -s 2
  ```
