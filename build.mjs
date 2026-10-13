// Builds the editor.
//   dist/                 static website (Vercel or any static host): index.html, manifest, icon, service worker
//   dist-artifact/index.html   single-file page for a Claude artifact (no document skeleton)
import { build } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const res = await build({
  entryPoints: ["src/ui/main.ts"], bundle: true, minify: true, format: "iife", target: "es2020",
  write: false, loader: { ".json": "json" },
});
const js = res.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const css = readFileSync("src/ui/style.css", "utf8");
const page = readFileSync("src/ui/template.html", "utf8")
  .replace("/*CSS*/", () => css)
  .replace("/*JS*/", () => js);

// Artifact build: the platform adds the document skeleton.
mkdirSync("dist-artifact", { recursive: true });
writeFileSync("dist-artifact/index.html", page);

// Website build: a full document with app metadata for "Add to Home Screen".
const split = page.indexOf('<div class="app">');
const headBits = page.slice(0, split), body = page.slice(split);
const icon = readFileSync("public/icon.svg", "utf8");
const web = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="description" content="Edit Pokémon Ruby, Sapphire, Emerald, FireRed, LeafGreen and pokeemerald-expansion / CFRU hack saves in your browser. Files never leave your device.">
<meta name="theme-color" content="#1f6f68" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#111816" media="(prefers-color-scheme: dark)">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/icon.svg">
${headBits}
</head>
<body>
${body}
<script>if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("/sw.js").catch(() => {});</script>
</body>
</html>
`;
mkdirSync("dist", { recursive: true });
writeFileSync("dist/index.html", web);
writeFileSync("dist/icon.svg", icon);
writeFileSync("dist/manifest.webmanifest", JSON.stringify({
  name: "Gen III Save Editor", short_name: "Gen III Saves", start_url: "/", display: "standalone",
  background_color: "#e9ede6", theme_color: "#1f6f68",
  icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" }],
}, null, 2));
// Offline support: cache the page so it opens without a connection after the first visit.
const version = Date.now().toString(36);
writeFileSync("dist/sw.js", `const C = "gen3-${version}";
self.addEventListener("install", e => { e.waitUntil(caches.open(C).then(c => c.addAll(["/", "/icon.svg", "/manifest.webmanifest"])).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== C).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  e.respondWith(fetch(e.request).then(r => { const copy = r.clone(); if (r.ok && new URL(e.request.url).origin === location.origin) caches.open(C).then(c => c.put(e.request, copy)); return r; })
    .catch(() => caches.match(e.request).then(r => r || caches.match("/"))));
});
`);
console.log(`dist/index.html ${(web.length / 1024).toFixed(0)} KB, dist-artifact/index.html ${(page.length / 1024).toFixed(0)} KB`);
