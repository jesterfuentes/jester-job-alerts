// OnlineJobs.ph job alert checker.
//
//   node checker.mjs                 PC mode: ONLY sends the "PC is online" heartbeat.
//                                    Never contacts OnlineJobs.ph (keeps the home IP out of it).
//   node checker.mjs --cloud         Real check (GitHub Actions runs this): reads OLJ search results
//                                    and sends new matching jobs to the PC topic if the PC heartbeat
//                                    is fresh, otherwise to the phone topic.
//   node checker.mjs --cloud --test  Same, but sends one alert from the newest matching job.
//
// Duplicates are prevented by reading the last 12h of both alert topics from ntfy.
// Private values: secrets.json (local) or env NTFY_TOPIC / PC_TOPIC / HEARTBEAT_TOPIC (cloud).

import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
const secretsPath = join(dir, "secrets.json");
const secrets = existsSync(secretsPath) ? JSON.parse(readFileSync(secretsPath, "utf8")) : {};
const topic = (envName, key) => (process.env[envName] || secrets[key] || "").trim();
const PHONE_TOPIC = topic("NTFY_TOPIC", "ntfyTopic");
const PC_TOPIC = topic("PC_TOPIC", "pcTopic");
const HEARTBEAT_TOPIC = topic("HEARTBEAT_TOPIC", "heartbeatTopic");

const CLOUD = process.argv.includes("--cloud");
const TEST = process.argv.includes("--test");
if (!HEARTBEAT_TOPIC || (CLOUD && (!PHONE_TOPIC || !PC_TOPIC))) {
  console.error("Missing topics: set secrets.json (PC) or NTFY_TOPIC / PC_TOPIC / HEARTBEAT_TOPIC env vars (cloud).");
  process.exit(1);
}

const logPath = join(dir, "run.log");
const BASE = "https://www.onlinejobs.ph";
const NTFY = "https://ntfy.sh";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) personal-job-alert/1.0";

const log = (msg) => {
  const line = `${new Date().toISOString()}  ${CLOUD ? "[cloud] " : "[pc] "}${msg}`;
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

function alertPayload(topic, job) {
  return {
    topic,
    title: `New OLJ: ${job.title}`.slice(0, 120),
    message: [job.pay, [job.type, job.posted && `posted ${job.posted}`].filter(Boolean).join(" · "), job.desc.slice(0, 180)]
      .filter(Boolean).join("\n"),
    click: job.url,
    priority: 4,
    tags: ["briefcase"],
    actions: [{ action: "view", label: "Open job", url: job.url }],
  };
}

// Messages ntfy still has for a topic (it keeps 12 hours).
async function ntfyHistory(topic, since) {
  const res = await fetch(`${NTFY}/${topic}/json?poll=1&since=${since}`);
  if (!res.ok) throw new Error(`ntfy history HTTP ${res.status}`);
  return (await res.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((m) => m.event === "message");
}

async function main() {
  // PC mode: heartbeat only. Silent (min priority) "PC is online" ping.
  if (!CLOUD) {
    await ntfyPost({ topic: HEARTBEAT_TOPIC, message: "alive", priority: 1 });
    return log("heartbeat sent (PC mode does not contact OnlineJobs.ph)");
  }

  // Where should alerts go? PC if its heartbeat is fresh, otherwise the phone.
  let pcOnline = false;
  try {
    pcOnline = (await ntfyHistory(HEARTBEAT_TOPIC, `${config.heartbeatMaxAgeMin}m`)).length > 0;
  } catch (e) {
    log(`cannot read heartbeat, assuming PC is off: ${e.message}`);
  }
  // routing "both" = send to PC and phone (used while setting up); "auto" = PC if online, else phone
  const destinations = config.routing === "auto" ? [pcOnline ? PC_TOPIC : PHONE_TOPIC] : [PC_TOPIC, PHONE_TOPIC];
  log(`PC ${pcOnline ? "online" : "offline"}, routing=${config.routing} -> ${destinations.length} destination(s)`);

  // Job IDs already alerted to either topic in the last 12h.
  let phoneHistory = [], pcHistory = [];
  try {
    [phoneHistory, pcHistory] = await Promise.all([ntfyHistory(PHONE_TOPIC, "12h"), ntfyHistory(PC_TOPIC, "12h")]);
  } catch (e) {
    return log(`cannot read alert history, stopping to avoid duplicates: ${e.message}`);
  }
  const alerted = new Set(
    [...phoneHistory, ...pcHistory].map((m) => (m.click || "").match(/-(\d+)\/?$/)?.[1]).filter(Boolean)
  );

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
    log("ALL searches failed — site may be down or blocking.");
    // Warn once per 12h (to the phone), then exit quietly so GitHub doesn't send failed-run emails.
    if (![...phoneHistory].some((m) => (m.title || "").startsWith("OLJ cloud"))) {
      await ntfyPost({
        topic: PHONE_TOPIC,
        title: "OLJ cloud backup can't reach OnlineJobs.ph",
        message: "GitHub is being blocked or the site is down. Tell Claude so we can fix it.",
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
    for (const t of destinations) await ntfyPost(alertPayload(t, job));
    return log(`TEST alert sent: ${job.title}`);
  }

  // Only recent jobs: newer than the cutoff, and within maxAgeHours
  // (alert history only goes back 12h, so older jobs can't be checked for duplicates).
  const oldestOk = Math.max(Date.now() - config.maxAgeHours * 3600e3, Date.parse(config.notBefore));
  const fresh = matches.filter((j) => !alerted.has(j.id) && j.postedMs >= oldestOk);
  log(`fetched ${all.length} jobs, ${matches.length} match, ${fresh.length} to alert`);

  for (const job of fresh.reverse()) { // oldest of the new ones first
    try {
      for (const t of destinations) await ntfyPost(alertPayload(t, job));
      log(`ALERT: ${job.title} — ${job.url}`);
    } catch (e) {
      log(`notify failed for ${job.id}: ${e.message}`); // not in history, so the next run retries it
    }
  }
}

main().catch((e) => { log(`ERROR: ${e.stack || e.message}`); process.exit(1); });
