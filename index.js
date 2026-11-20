import express from "express";
import https from "node:https";
import zlib from "node:zlib";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PORT = process.env.PORT || 7000;
const SUBS = (process.env.SUBS_UPSTREAM || "https://opensubtitles-v3.strem.io").replace(/\/$/, "");
const skips = () => JSON.parse(readFileSync(join(process.cwd(), "skips.json"), "utf8"));

const manifest = {
  id: "community.skipscenes.warnings",
  version: "1.0.0",
  name: "Skip Warnings",
  description: "Shows a warning 10 seconds before flagged scenes, merged with English subtitles.",
  resources: ["subtitles"],
  types: ["movie", "series"],
  idPrefixes: ["tt"],
  catalogs: [],
};

const app = express();
app.set("trust proxy", true);
app.use((req, res, next) => { res.setHeader("Access-Control-Allow-Origin", "*"); res.setHeader("Access-Control-Allow-Headers", "*"); next(); });

const ts = t => {
  t = Math.max(0, t);
  const p = (n, l = 2) => String(Math.floor(n)).padStart(l, "0");
  return `${p(t / 3600)}:${p((t % 3600) / 60)}:${p(t % 60)},${p((t % 1) * 1000, 3)}`;
};
const hms = t => `${Math.floor(t / 3600)}:${String(Math.floor((t % 3600) / 60)).padStart(2, "0")}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
const toSec = t => { const m = t.match(/(\d+):(\d+):(\d+)[,.](\d+)/); return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000; };

function parseSrt(txt) {
  return txt.replace(/^﻿/, "").replace(/\r/g, "").split(/\n\n+/).map(b => {
    const l = b.split("\n");
    const i = l.findIndex(x => x.includes("-->"));
    if (i < 0) return null;
    const [a, c] = l[i].split("-->");
    return { a: toSec(a), b: toSec(c), text: l.slice(i + 1).join("\n") };
  }).filter(Boolean);
}

function warnCues(ranges) {
  const o = [];
  for (const [a, b] of ranges) {
    o.push({ a: a - 10, b: a, text: `⚠ Scene coming in 10 seconds — skip ahead to ${hms(b)}` });
    o.push({ a, b: Math.min(a + 8, b), text: `⚠ SKIP NOW — jump to ${hms(b)}` });
    o.push({ a: b, b: b + 4, text: "✅ Scene is over" });
  }
  return o;
}

const toSrt = cues => cues.sort((x, y) => x.a - y.a)
  .map((c, i) => `${i + 1}\n${ts(c.a)} --> ${ts(c.b)}\n${c.text}\n`).join("\n");

const rangesFor = id => { const all = skips(); return all[id] || all[id.split(":")[0]]; };

function download(u) {
  return new Promise((ok, no) => https.get(u, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
      "Accept": "*/*", "Accept-Language": "en-US,en;q=0.9", "Referer": "https://web.stremio.com/",
    },
  }, r => {
    const c = [];
    r.on("data", d => c.push(d));
    r.on("end", () => ok({ status: r.statusCode, buf: Buffer.concat(c) }));
  }).on("error", no));
}

function decode(buf) {
  let raw = buf;
  if (raw[0] === 0x1f && raw[1] === 0x8b) raw = zlib.gunzipSync(raw);
  let enc = "utf-8";
  if (raw[0] === 0xff && raw[1] === 0xfe) enc = "utf-16le";
  else if (raw[0] === 0xfe && raw[1] === 0xff) { raw = Buffer.from(raw).swap16(); enc = "utf-16le"; }
  else if (raw.subarray(0, 400).filter(b => b === 0).length > 100) enc = "utf-16le";
  return new TextDecoder(enc).decode(raw);
}

app.get("/", (_, res) => res.send(`<body style="font:18px sans-serif;padding:30px"><h2>Skip Warnings add-on</h2>
<p>Install in Stremio with: <b>this address/manifest.json</b></p>`));

app.get("/manifest.json", (_, res) => res.json(manifest));

app.get(["/subtitles/:type/:id.json", "/subtitles/:type/:id/:extra.json"], async (req, res) => {
  const id = req.params.id;
  if (!rangesFor(id)) return res.json({ subtitles: [] });
  const host = `${req.protocol}://${req.get("host")}`;
  const out = [{ id: "skipwarn-" + id, lang: "Skip Warnings only", url: `${host}/sub/${encodeURIComponent(id)}.srt` }];
  try {
    const x = req.params.extra ? "/" + req.params.extra : "";
    const up = await (await fetch(`${SUBS}/subtitles/${req.params.type}/${id}${x}.json`)).json();
    (up.subtitles || []).filter(t => /^(en|eng)/i.test(t.lang)).slice(0, 4).forEach((t, i) =>
      out.unshift({ id: `merged-${i}-${id}`, lang: `English + Skip Warnings ${i + 1}`,
        url: `${host}/msub/${encodeURIComponent(id)}.srt?u=${encodeURIComponent(t.url)}` }));
  } catch (e) { console.log("subs upstream failed", e.message); }
  res.json({ subtitles: out });
});

app.get("/msub/:id.srt", async (req, res) => {
  const ranges = rangesFor(req.params.id) || [];
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  try {
    const u = new URL(req.query.u);
    if (!/(^|\.)strem\.io$/.test(u.hostname)) return res.send(toSrt(warnCues(ranges)));
    const { status, buf } = await download(u);
    const subs = parseSrt(decode(buf));
    console.log("MSUB", req.params.id, "HTTP", status, "bytes", buf.length, "cues", subs.length);
    res.send(toSrt([...subs, ...warnCues(ranges)]));
  } catch (e) {
    console.log("MSUB FAILED", e.message);
    res.send(toSrt(warnCues(ranges)));
  }
});

app.get("/sub/:id.srt", (req, res) => {
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.send(toSrt(warnCues(rangesFor(req.params.id) || [])));
});

app.get("/skips/:id", (req, res) => res.json(rangesFor(req.params.id) || []));

export default app;
if (!process.env.VERCEL) app.listen(PORT, () => console.log(`Skip Warnings add-on listening on ${PORT}`));
