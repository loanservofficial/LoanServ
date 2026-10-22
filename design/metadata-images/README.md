# Metadata image sources

`src/app/icon.png`, `src/app/apple-icon.png` and `src/app/opengraph-image.png`
are static files rendered from the `.tsx` designs in this folder.

They used to be `next/og` routes in `src/app/`. Next prerendered them at build
time anyway, but the routes pulled the image renderer (resvg/yoga WASM, a font
and satori, about 0.7 MiB compressed) into the server bundle, which pushed the
Cloudflare worker over the free plan's 3 MiB limit. Static files cost nothing
at runtime.

To change a design:

1. Edit the `.tsx` here, then copy it back to `src/app/` and delete the
   matching `.png` there (Next refuses both at once).
2. Run `npm run build`.
3. Copy `.next/server/app/<name>.body` to `src/app/<name>.png` (it is the PNG),
   and move the `.tsx` back here.

`opengraph-image.alt.txt` in `src/app/` holds the OG image's alt text.
