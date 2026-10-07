# Fonts

The page's three typefaces, bundled so the page requests no fonts from another
origin. The build
(`scripts/build-single-html.js`) inlines each file as a `data:` URI from
`src/css/fonts.css`.

| File | Typeface | Weights |
| --- | --- | --- |
| `archivo-latin.woff2` | Archivo (variable) | 500–700 |
| `ibm-plex-sans-latin.woff2` | IBM Plex Sans (variable) | 400–600 |
| `ibm-plex-mono-{400,500,600}-latin.woff2` | IBM Plex Mono | 400, 500, 600 |

Latin subset only (the `unicode-range` in `fonts.css`); text in other scripts
uses the system font next in each `font-family` list.

The files are as served by Google Fonts, unmodified, from
`fonts.googleapis.com/css2?family=Archivo:wght@500;600;700&family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600`
(the latin `@font-face` blocks). To update, fetch that CSS with a current
browser's User-Agent, download the latin files, and replace these.

## Licence

Both typefaces are under the SIL Open Font License 1.1:

- Archivo: Copyright 2020 The Archivo Project Authors (https://github.com/Omnibus-Type/Archivo). `OFL-archivo.txt`
- IBM Plex: Copyright © 2017 IBM Corp. with Reserved Font Name "Plex". `OFL-ibmplexsans.txt`, `OFL-ibmplexmono.txt`

The licence allows bundling and redistribution with software, provided the
copyright notice and licence go with the fonts (this folder, and the comment
at the top of `fonts.css`, which the build keeps).
