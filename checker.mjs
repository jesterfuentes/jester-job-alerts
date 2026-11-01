// OnlineJobs.ph job alert checker.
// Reads public search results, sends new matching jobs to your phone via ntfy.
//
// Two ways to run it:
//   PC mode (default)   remembers jobs in seen.json, sends a "PC is alive" heartbeat when done.
//   Cloud mode (--cloud) GitHub backup: does nothing while the PC's heartbeat is fresh;
//                        otherwise checks, using your ntfy alert history to avoid duplicates.
//
// Flags:
//   --seed    remember all current jobs WITHOUT alerting (first run)
//   --test    send ONE real-looking alert from the newest matching job
//   --cloud   cloud mode
//   --force   (cloud) ignore the heartbeat and check anyway
//
// Private values come from secrets.json (PC) or env vars NTFY_TOPIC / HEARTBEAT_TOPIC (cloud).

import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
const secretsPath = join(dir, "secrets.json");
const secrets = existsSync(secretsPath) ? JSON.parse(readFileSync(secretsPath, "utf8")) : {};
const ALERT_TOPIC = process.env.NTFY_TOPIC || secrets.ntfyTopic;
const HEARTBEAT_TOPIC = process.env.HEARTBEAT_TOPIC || secrets.heartbeatTopic;
if (!ALERT_TOPIC || !HEARTBEAT_TOPIC) {
  console.error("Missing topics: set secrets.json (PC) or NTFY_TOPIC / HEARTBEAT_TOPIC env vars (cloud).");
  process.exit(1);
}

const seenPath = join(dir, "seen.json");
const logPath = join(dir, "run.log");
const SEED = process.argv.includes("--seed");
const TEST = process.argv.includes("--test");
const CLOUD = process.argv.includes("--cloud");
const FORCE = process.argv.includes("--force");
const BASE = "https://www.onlinejobs.ph";
const NTFY = "https://ntfy.sh";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) personal-job-alert/1.0";

const log = (msg) => {
  const line = `${new Date().toISOString()}  ${CLOUD ? "[cloud] " : ""}${msg}`;
  console.log(line);
  try { appendFileSync(logPath, line + "\n"); } catch {}
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const decode = (s) =>
  s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&nbsp;/g, " ");

const clean = (html) =>
  decode(html.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

function parseJobs(html) {
  const jobs = [];
  for (const chunk of html.split("<!-- Start -->").slice(1)) {
    const href = chunk.match(/href="(\/jobseekers\/job\/[^"]*?-(\d+))"/);
    if (!href) continue;
    const h4 = chunk.match(/<h4[^>]*>([\s\S]*?)<\/h4>/);
    const badge = h4 && h4[1].match(/<span class="badge[^"]*"[^>]*>([\s\S]*?)<\/span>/);
    const title = h4 ? clean(h4[1].replace(/<span[\s\S]*?<\/span>/g, "")) : "(no title)";
    const posted = (chunk.match(/Posted on ([\d\- :]+)/) || [])[1] || "";
    // data-temp-2 is the posted time in UTC (the visible "Posted on" is Philippine time)
    const utc = (chunk.match(/data-temp-2="([\d\- :]+)"/) || [])[1];
    const postedMs = utc ? Date.parse(utc.replace(" ", "T") + "Z") : NaN;
    const pay = (chunk.match(/<dd class="col">([^<]*)<\/dd>/) || [])[1] || "";
    const descM = chunk.match(/<div class="desc[^>]*>([\s\S]*?)<\/div>/);
    jobs.push({
      id: href[2],
      url: BASE + href[1],
      title,
      type: badge ? clean(badge[1]) : "",
      posted: posted.trim(),
      postedMs,
      pay: clean(pay),
      desc: descM ? clean(descM[1]).replace(/\s*See More$/, "") : "",
    });
  }
  return jobs;
}

function isMatch(job) {
  const title = job.title.toLowerCase();
  const text = `${title} ${job.desc.toLowerCase()}`;
  if (config.excludeInTitle.some((w) => title.includes(w.toLowerCase()))) return false;
  // \b = start of a word, so "edit" matches "editor"/"editing" but not "credit"
  return config.mustMatch.some((w) => new RegExp("\\b" + w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(text));
}

async function fetchSearch(term) {
  const url = `${BASE}/jobseekers/jobsearch?jobkeyword=${encodeURIComponent(term)}`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for "${term}"`);
  return parseJobs(await res.text());
}

async function ntfyPost(payload) {
  const res = await fetch(NTFY + "/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`ntfy HTTP ${res.status}`);
}

const notify = (job) =>
  ntfyPost({
    topic: ALERT_TOPIC,
    title: `New OLJ: ${job.title}`.slice(0, 120),
    message: [job.pay, [job.type, job.posted && `posted ${job.posted}`].filter(Boolean).join(" · "), job.desc.slice(0, 180)]
      .filter(Boolean).join("\n"),
    click: job.url,
    priority: 4,
    tags: ["briefcase"],
    actions: [{ action: "view", label: "Open job", url: job.url }],
  });

// Messages ntfy still has for a topic (it keeps 12 hours).
async function ntfyHistory(topic, since) {
  const res = await fetch(`${NTFY}/${topic}/json?poll=1&since=${since}`);
  if (!res.ok) throw new Error(`ntfy history HTTP ${res.status}`);
  return (await res.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((m) => m.event === "message");
}

async function main() {
  // Cloud mode: stand down while the PC is alive.
  if (CLOUD && !FORCE) {
    const beats = await ntfyHistory(HEARTBEAT_TOPIC, `${config.heartbeatMaxAgeMin}m`);
    if (beats.length) return log(`PC heartbeat is fresh (${beats.length} in last ${config.heartbeatMaxAgeMin} min) — skipping`);
    log("no PC heartbeat — PC looks off, cloud will check");
  }

  // Job IDs already alerted (by the PC or the cloud) in the last 12h.
  let history = [];
  try {
    history = await ntfyHistory(ALERT_TOPIC, "12h");
  } catch (e) {
    if (CLOUD) return log(`cannot read alert history, stopping to avoid duplicates: ${e.message}`);
    log(`warning: cannot read alert history: ${e.message}`);
  }
  const alerted = new Set(history.map((m) => (m.click || "").match(/-(\d+)\/?$/)?.[1]).filter(Boolean));

  const seen = new Set(!CLOUD && existsSync(seenPath) ? JSON.parse(readFileSync(seenPath, "utf8")) : []);
  const found = new Map();
  let failures = 0;

  for (const term of config.searches) {
    try {
      for (const job of await fetchSearch(term)) if (!found.has(job.id)) found.set(job.id, job);
    } catch (e) {
      failures++;
      log(`search failed: ${e.message}`);
    }
    await sleep(config.delayBetweenSearchesMs);
  }

  if (failures === config.searches.length) {
    log("ALL searches failed — site may be down or blocking. Nothing saved.");
    if (!CLOUD) process.exit(1);
    // Cloud: warn the phone once per 12h, then exit quietly (no failed-run email spam).
    if (!history.some((m) => (m.title || "").startsWith("OLJ cloud"))) {
      await ntfyPost({
        topic: ALERT_TOPIC,
        title: "OLJ cloud backup can't reach OnlineJobs.ph",
        message: "The GitHub backup is being blocked or the site is down. Keep your PC on for alerts.",
        priority: 3,
        tags: ["warning"],
      });
    }
    return;
  }

  // newest first by ID (higher ID = newer)
  const all = [...found.values()].sort((a, b) => Number(b.id) - Number(a.id));
  const matches = all.filter(isMatch);

  if (TEST) {
    const job = matches[0];
    if (!job) return log("no matching job to test with");
    await notify(job);
    return log(`TEST alert sent: ${job.title}`);
  }

  // Only alert on recent jobs: newer than the cutoff, and not older than maxAgeHours
  // (the alert history only goes back 12h, so older jobs can't be checked for duplicates).
  const oldestOk = Math.max(Date.now() - config.maxAgeHours * 3600e3, Date.parse(config.notBefore));
  const fresh = matches.filter((j) => !seen.has(j.id) && !alerted.has(j.id) && j.postedMs >= oldestOk);
  log(`fetched ${all.length} jobs, ${matches.length} match, ${fresh.length} to alert${SEED ? " (seed mode: no alerts)" : ""}`);

  const failedIds = new Set();
  if (!SEED) {
    for (const job of fresh.reverse()) { // oldest of the new ones first
      try {
        await notify(job);
        log(`ALERT: ${job.title} — ${job.url}`);
      } catch (e) {
        log(`notify failed for ${job.id}: ${e.message}`);
        failedIds.add(job.id); // not remembered, so the next run retries it
      }
    }
  }

  if (!CLOUD) {
    // remember everything we saw (matched or not) so it never alerts twice
    for (const j of all) if (!failedIds.has(j.id)) seen.add(j.id);
    const keep = [...seen].sort((a, b) => Number(b) - Number(a)).slice(0, 5000);
    writeFileSync(seenPath, JSON.stringify(keep));

    // "PC is alive" ping so the cloud backup stays quiet. Silent (min priority), only after a good run.
    try {
      await ntfyPost({ topic: HEARTBEAT_TOPIC, message: "alive", priority: 1 });
    } catch (e) {
      log(`heartbeat failed: ${e.message}`);
    }
  }
}

main().catch((e) => { log(`ERROR: ${e.stack || e.message}`); process.exit(1); });
