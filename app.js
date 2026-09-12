/* ---------------------------------------------------------------------
   Scoreboard — data source is ESPN's public (unofficial) site API.
   No key required, but it's undocumented, so field shapes are handled
   defensively throughout. If ESPN changes something, check the browser
   console first — every fetch path logs on failure.
   ------------------------------------------------------------------ */

const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports";

const SPORTS = {
  cfb:  { key:"cfb",  label:"College Football",   sport:"football",  league:"college-football",        college:true,  scoreboardParams:"?groups=80&limit=400", priorityTeam:"Mississippi State" },
  cbb:  { key:"cbb",  label:"College Basketball",  sport:"basketball", league:"mens-college-basketball", college:true,  scoreboardParams:"?groups=50&limit=400", priorityTeam:"Mississippi State" },
  cbsb: { key:"cbsb", label:"College Baseball",    sport:"baseball",  league:"college-baseball",        college:true,  scoreboardParams:"?limit=400",           priorityTeam:"Mississippi State" },
  nfl:  { key:"nfl",  label:"NFL",                 sport:"football",  league:"nfl",                    college:false, scoreboardParams:"",                     priorityTeams:["Saints","Cowboys"] },
  mlb:  { key:"mlb",  label:"MLB",                 sport:"baseball",  league:"mlb",                    college:false, scoreboardParams:"",                     priorityTeams:["Pirates","Dodgers"] },
};

// Conference rosters reflect the 2024-25 realignment as best known. Used
// across all three college tabs (football/basketball/baseball share the
// same power-conference membership closely enough for this purpose).
// Edit these lists directly if a team switches conferences.
const CONFERENCES = {
  "SEC": ["Alabama","Arkansas","Auburn","Florida","Georgia","Kentucky","LSU","Mississippi State","Missouri","Ole Miss","Oklahoma","South Carolina","Tennessee","Texas","Texas A&M","Vanderbilt"],
  "Big Ten": ["Illinois","Indiana","Iowa","Maryland","Michigan","Michigan State","Minnesota","Nebraska","Northwestern","Ohio State","Oregon","Penn State","Purdue","Rutgers","UCLA","USC","Washington","Wisconsin"],
  "Big 12": ["Arizona","Arizona State","Baylor","BYU","Cincinnati","Colorado","Houston","Iowa State","Kansas","Kansas State","Oklahoma State","TCU","Texas Tech","UCF","Utah","West Virginia"],
  "ACC": ["Boston College","California","Clemson","Duke","Florida State","Georgia Tech","Louisville","Miami","NC State","North Carolina","Notre Dame","Pittsburgh","SMU","Stanford","Syracuse","Virginia","Virginia Tech","Wake Forest"],
  "American": ["Charlotte","East Carolina","Florida Atlantic","Memphis","Navy","North Texas","Rice","South Florida","Temple","Tulane","Tulsa","UAB","UTSA","Army"],
  "Mountain West": ["Air Force","Boise State","Colorado State","Fresno State","Hawai'i","Nevada","New Mexico","San Diego State","San Jose State","UNLV","Utah State","Wyoming"],
  "MAC": ["Akron","Ball State","Bowling Green","Buffalo","Central Michigan","Eastern Michigan","Kent State","Miami (OH)","Northern Illinois","Ohio","Toledo","Western Michigan"],
  "Conference USA": ["Delaware","Missouri State","Jacksonville State","Kennesaw State","Liberty","Louisiana Tech","Middle Tennessee","New Mexico State","Sam Houston","UTEP","Western Kentucky"],
  "Sun Belt": ["Appalachian State","Arkansas State","Coastal Carolina","Georgia Southern","Georgia State","James Madison","Louisiana","Louisiana Monroe","Marshall","Old Dominion","South Alabama","Southern Miss","Texas State","Troy"],
};

const state = { currentTab: null, query: "", cache: {}, activeGame: null };
let livePollTimer = null;
let searchDebounce = null;

/* ---------------------------- utilities ---------------------------- */

function escapeHTML(str){
  return String(str == null ? "" : str).replace(/[&<>"']/g, (s) => (
    { "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[s]
  ));
}

function formatLocalTime(iso){
  const d = new Date(iso);
  const datePart = d.toLocaleDateString(undefined, { weekday:"short", month:"short", day:"numeric" });
  const timePart = d.toLocaleTimeString(undefined, { hour:"numeric", minute:"2-digit" });
  return `${datePart} \u00b7 ${timePart}`;
}

function getConference(locationStr){
  if(!locationStr) return null;
  const norm = locationStr.trim().toLowerCase();
  for(const [conf, teams] of Object.entries(CONFERENCES)){
    if(teams.some((t) => t.toLowerCase() === norm)) return conf;
  }
  return null;
}

async function fetchJSON(url){
  try{
    const r = await fetch(url, { cache: "no-store" });
    if(!r.ok) throw new Error("status " + r.status);
    return await r.json();
  } catch(err){
    // ESPN's site API is generally reachable directly; fall back to a
    // public CORS proxy if the direct request gets blocked somewhere.
    console.warn("Direct fetch failed, retrying via proxy:", url, err);
    const proxied = "https://api.allorigins.win/raw?url=" + encodeURIComponent(url);
    const r2 = await fetch(proxied, { cache: "no-store" });
    if(!r2.ok) throw new Error("proxy status " + r2.status);
    return await r2.json();
  }
}

/* ---------------------- normalizing ESPN payloads -------------------- */

function getRank(c){
  let r = null;
  if(c.curatedRank && typeof c.curatedRank.current === "number") r = c.curatedRank.current;
  else if(typeof c.rank === "number") r = c.rank;
  if(r && r >= 1 && r <= 25) return r;
  return null;
}

function getRecord(c){
  if(!c.records || !c.records.length) return null;
  const overall = c.records.find((r) => r.name === "overall" || r.type === "total") || c.records[0];
  return (overall && overall.summary) || null;
}

function extractTeam(c){
  if(!c) return { displayName:"TBD", location:"", abbreviation:"", logo:"", score:null, winner:false, rank:null, record:null };
  const t = c.team || {};
  return {
    id: t.id,
    location: t.location || t.displayName || t.name || "",
    displayName: t.displayName || (t.location ? `${t.location} ${t.name || ""}`.trim() : (t.name || "Team")),
    abbreviation: t.abbreviation || "",
    logo: t.logo || (t.logos && t.logos[0] && t.logos[0].href) || "",
    score: c.score !== undefined ? c.score : null,
    winner: !!c.winner,
    rank: getRank(c),
    record: getRecord(c),
    homeAway: c.homeAway,
  };
}

function extractOdds(comp){
  const o = comp.odds && comp.odds[0];
  if(!o) return null;
  const details = o.details || "";
  const overUnder = o.overUnder;
  if(!details && !overUnder) return null;
  return { details, overUnder };
}

// Conservative list of networks generally carried on YouTube TV's base
// plan. Regional sports networks and market-by-market carriage aren't
// reliably knowable from this data, so this errs toward only flagging
// widely-carried national networks.
const YOUTUBE_TV_CHANNELS = new Set([
  "ABC","CBS","NBC","FOX","ESPN","ESPN2","ESPNU","ESPNEWS","FS1","FS2",
  "TBS","TNT","TRUTV","NFL NETWORK","NFLN","NBA TV","MLB NETWORK","MLBN",
  "BIG TEN NETWORK","BTN","SEC NETWORK","SECN","ACC NETWORK","ACCN",
  "CBS SPORTS NETWORK","GOLF CHANNEL","PAC-12 NETWORK",
]);

function extractBroadcast(comp){
  if(comp.broadcasts && comp.broadcasts.length){
    const names = comp.broadcasts.flatMap((b) => b.names || []).filter(Boolean);
    if(names.length) return [...new Set(names)].join(", ");
  }
  if(comp.geoBroadcasts && comp.geoBroadcasts.length){
    const names = comp.geoBroadcasts.map((b) => b.media && b.media.shortName).filter(Boolean);
    if(names.length) return [...new Set(names)].join(", ");
  }
  if(typeof comp.broadcast === "string" && comp.broadcast) return comp.broadcast;
  return null;
}

function isOnYouTubeTV(broadcastStr){
  if(!broadcastStr) return false;
  const tokens = broadcastStr.split(/[,/]/).map((s) => s.trim().toUpperCase()).filter(Boolean);
  return tokens.some((t) => YOUTUBE_TV_CHANNELS.has(t));
}

function normalizeEvent(evt, sportKey){
  const comp = (evt.competitions && evt.competitions[0]) || {};
  const competitors = comp.competitors || [];
  const home = competitors.find((c) => c.homeAway === "home") || competitors[0];
  const away = competitors.find((c) => c.homeAway === "away") || competitors[1];
  const statusType = (comp.status && comp.status.type) || (evt.status && evt.status.type) || {};
  return {
    id: evt.id,
    date: evt.date,
    state: statusType.state || "pre",
    completed: !!statusType.completed,
    statusDetail: statusType.shortDetail || statusType.detail || "",
    home: extractTeam(home),
    away: extractTeam(away),
    odds: extractOdds(comp),
    broadcast: extractBroadcast(comp),
    __sportKey: sportKey,
  };
}

/* ---------------------------- data fetching --------------------------- */

async function fetchScoreboard(sportKey){
  const conf = SPORTS[sportKey];
  const content = document.getElementById("content");
  try{
    const url = `${ESPN_BASE}/${conf.sport}/${conf.league}/scoreboard${conf.scoreboardParams || ""}`;
    const data = await fetchJSON(url);
    let events = (data.events || []).map((evt) => normalizeEvent(evt, sportKey));

    if(!events.length && conf.scoreboardParams){
      // retry without the groups filter in case that id is off
      const fallbackData = await fetchJSON(`${ESPN_BASE}/${conf.sport}/${conf.league}/scoreboard`);
      events = (fallbackData.events || []).map((evt) => normalizeEvent(evt, sportKey));
    }

    state.cache[sportKey] = events;
    updateTimestamp();
    if(state.currentTab === sportKey) renderCurrentTabContent();
    return events;
  } catch(err){
    console.error("Scoreboard fetch failed for", sportKey, err);
    if(state.currentTab === sportKey){
      content.innerHTML = `<div class="empty-state">Couldn't load ${escapeHTML(conf.label)} right now. Check your connection and tap refresh.</div>`;
    }
    return [];
  }
}

/* ------------------------------ sorting ------------------------------- */

function rankScore(e){ return (e.home.rank || 99) + (e.away.rank || 99); }
function bothRanked(e){ return !!(e.home.rank && e.away.rank); }
function oneRanked(e){ return !!(e.home.rank || e.away.rank) && !bothRanked(e); }
function isConf(e, name){ return getConference(e.home.location) === name || getConference(e.away.location) === name; }

function buildCollegeSections(events, conf){
  const priority = conf.priorityTeam.toLowerCase();
  let msuGame = null;
  const rest = [];
  events.forEach((e) => {
    const isMsu = e.home.displayName.toLowerCase().includes(priority) || e.away.displayName.toLowerCase().includes(priority);
    if(isMsu && !msuGame) msuGame = e; else rest.push(e);
  });

  const secGames = rest.filter((e) => isConf(e, "SEC"));
  const nonSec = rest.filter((e) => !isConf(e, "SEC"));

  secGames.sort((a, b) => {
    const pa = bothRanked(a) ? 0 : oneRanked(a) ? 1 : 2;
    const pb = bothRanked(b) ? 0 : oneRanked(b) ? 1 : 2;
    return pa !== pb ? pa - pb : rankScore(a) - rankScore(b);
  });

  const rankedNonSec = nonSec.filter((e) => e.home.rank || e.away.rank);
  rankedNonSec.sort((a, b) => {
    const pa = bothRanked(a) ? 0 : 1;
    const pb = bothRanked(b) ? 0 : 1;
    return pa !== pb ? pa - pb : rankScore(a) - rankScore(b);
  });

  const others = nonSec.filter((e) => !(e.home.rank || e.away.rank));
  others.sort((a, b) => new Date(a.date) - new Date(b.date));

  return { msuGame, secGames, rankedNonSec, others, priorityLabel: conf.priorityTeam };
}

function buildProSections(events, conf){
  const names = conf.priorityTeams.map((n) => n.toLowerCase());
  const pinned = [];
  const rest = [];
  events.forEach((e) => {
    const match = names.some((n) => e.home.displayName.toLowerCase().includes(n) || e.away.displayName.toLowerCase().includes(n));
    if(match) pinned.push(e); else rest.push(e);
  });
  rest.sort((a, b) => new Date(a.date) - new Date(b.date));
  return { pinned, rest };
}

function matchesSearch(e, q){
  if(!q) return true;
  const query = q.toLowerCase();
  const hay = [
    e.home.displayName, e.home.abbreviation, e.away.displayName, e.away.abbreviation,
    getConference(e.home.location) || "", getConference(e.away.location) || "",
  ].join(" ").toLowerCase();
  return hay.includes(query);
}

/* ------------------------------ rendering ------------------------------ */

function sectionLabel(text){
  return `<div class="section-label">${escapeHTML(text)}<span class="rule"></span></div>`;
}

function statusLine(e){
  if(e.state === "pre") return escapeHTML(formatLocalTime(e.date));
  if(e.state === "in") return `<span class="dot"></span>${escapeHTML(e.statusDetail || "Live")}`;
  return escapeHTML(e.statusDetail || "Final");
}

function teamRowHTML(team, e){
  const outcome = e.completed ? (team.winner ? "winner" : "loser") : "";
  const rank = team.rank ? `<span class="team-rank">#${team.rank}</span>` : "";
  const record = team.record ? `<span class="team-record">${escapeHTML(team.record)}</span>` : "";
  const showScore = e.state !== "pre";
  const score = showScore ? `<span class="team-score">${team.score ?? "-"}</span>` : "";
  const logo = team.logo
    ? `<img class="team-logo" src="${team.logo}" alt="" onerror="this.style.visibility='hidden'">`
    : `<span class="team-logo"></span>`;
  return `<div class="team-row ${outcome}">
    <div class="team-left">${logo}${rank}<span class="team-name">${escapeHTML(team.displayName)}</span>${record}</div>
    ${score}
  </div>`;
}

function oddsLineHTML(e){
  if(!e.odds) return "";
  const parts = [];
  if(e.odds.details) parts.push(e.odds.details);
  if(e.odds.overUnder) parts.push(`O/U ${e.odds.overUnder}`);
  if(!parts.length) return "";
  return `<div class="odds-line">${escapeHTML(parts.join(" \u00b7 "))}</div>`;
}

function cardHTML(e, opts = {}){
  const pinnedClass = opts.pinned ? " pinned" : "";
  const liveClass = e.state === "in" ? " live" : "";
  return `<div class="card${pinnedClass}" onclick="openGame('${e.__sportKey}','${e.id}')">
    <div class="card-top"><span class="card-tag${liveClass}">${statusLine(e)}</span></div>
    ${oddsLineHTML(e)}
    ${teamRowHTML(e.away, e)}
    ${teamRowHTML(e.home, e)}
  </div>`;
}

function renderCollegeContent(sections){
  let html = sectionLabel(sections.priorityLabel);
  html += sections.msuGame
    ? cardHTML(sections.msuGame, { pinned: true })
    : `<div class="card placeholder">No ${escapeHTML(sections.priorityLabel)} game found right now.</div>`;

  html += sectionLabel("SEC games");
  html += sections.secGames.length
    ? sections.secGames.map((e) => cardHTML(e)).join("")
    : `<div class="empty-state">No SEC games match.</div>`;

  if(sections.rankedNonSec.length){
    html += sectionLabel("Top 25");
    html += sections.rankedNonSec.map((e) => cardHTML(e)).join("");
  }
  if(sections.others.length){
    html += sectionLabel("More games");
    html += sections.others.map((e) => cardHTML(e)).join("");
  }
  return html;
}

function renderProContent(sections, conf){
  let html = sectionLabel(conf.priorityTeams.join(" & "));
  html += sections.pinned.length
    ? sections.pinned.map((e) => cardHTML(e, { pinned: true })).join("")
    : `<div class="card placeholder">No ${escapeHTML(conf.priorityTeams.join(" or "))} game today.</div>`;

  if(sections.rest.length){
    html += sectionLabel("Around the league");
    html += sections.rest.map((e) => cardHTML(e)).join("");
  }
  return html;
}

function renderCurrentTabContent(){
  const sportKey = state.currentTab;
  const conf = SPORTS[sportKey];
  const content = document.getElementById("content");
  const all = state.cache[sportKey] || [];
  const events = all.filter((e) => matchesSearch(e, state.query));

  if(!all.length){
    content.innerHTML = `<div class="empty-state">No ${escapeHTML(conf.label)} games found right now.</div>`;
    return;
  }
  if(!events.length && state.query){
    content.innerHTML = `<div class="empty-state">No games match "${escapeHTML(state.query)}".</div>`;
    return;
  }

  content.innerHTML = conf.college
    ? renderCollegeContent(buildCollegeSections(events, conf))
    : renderProContent(buildProSections(events, conf), conf);
}

async function renderTab(sportKey){
  state.currentTab = sportKey;
  highlightActiveTab(sportKey);
  if(state.cache[sportKey]){
    renderCurrentTabContent();
  } else {
    document.getElementById("content").innerHTML = `<div class="loading-line" style="padding:20px 2px;">Loading ${escapeHTML(SPORTS[sportKey].label)}\u2026</div>`;
    await fetchScoreboard(sportKey);
  }
}

/* -------------------------------- tabs --------------------------------- */

function tabBtnHTML(key){
  return `<button class="tab" data-key="${key}" onclick="switchTab('${key}')">${escapeHTML(SPORTS[key].label)}</button>`;
}

function renderTabsBar(){
  const nav = document.getElementById("tabs");
  let html = '<div class="tab-group">';
  ["cfb", "cbb", "cbsb"].forEach((k) => { html += tabBtnHTML(k); });
  html += '</div><div class="tab-sep"></div><div class="tab-group">';
  ["nfl", "mlb"].forEach((k) => { html += tabBtnHTML(k); });
  html += "</div>";
  nav.innerHTML = html;
}

function highlightActiveTab(key){
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.key === key));
}

function switchTab(key){
  state.query = "";
  document.getElementById("search").value = "";
  renderTab(key);
}

function getDefaultTab(){
  const m = new Date().getMonth() + 1;
  if([8, 9, 10, 11, 12, 1].includes(m)) return "cfb";
  if([11, 12, 1, 2, 3, 4].includes(m)) return "cbb";
  if([2, 3, 4, 5, 6, 7].includes(m)) return "cbsb";
  return "cfb";
}

/* -------------------------------- search -------------------------------- */

function onSearch(v){
  state.query = v.trim();
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => renderCurrentTabContent(), 120);
}

/* ------------------------------- refresh -------------------------------- */

function updateTimestamp(){
  document.getElementById("updated-at").textContent = new Date().toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

async function manualRefresh(){
  const btn = document.getElementById("refresh-btn");
  btn.classList.add("spinning");
  await fetchScoreboard(state.currentTab);
  btn.classList.remove("spinning");
}

function modalOpen(){
  return !document.getElementById("modal-overlay").classList.contains("hidden");
}

/* --------------------------------- modal --------------------------------- */

// Android supports launching an installed app directly via an intent://
// URL with a package fallback to the web URL if the app isn't installed.
// iOS has no publicly documented custom URL scheme for YouTube TV, so we
// fall back to the plain https link there and rely on iOS's own Universal
// Link resolution to hand off to the app when it's installed.
const YTTV_WEB_URL = "https://tv.youtube.com/";
const YTTV_ANDROID_INTENT = "intent://tv.youtube.com/#Intent;scheme=https;package=com.google.android.apps.youtube.unplugged;S.browser_fallback_url=" + encodeURIComponent(YTTV_WEB_URL) + ";end";

function isAndroidDevice(){
  return /Android/i.test(navigator.userAgent || "");
}

function broadcastHTML(e){
  if(!e.broadcast) return "";
  const onYTTV = isOnYouTubeTV(e.broadcast);
  let link = "";
  if(onYTTV){
    link = isAndroidDevice()
      ? ` &middot; <a href="${YTTV_ANDROID_INTENT}" class="yttv-link">Watch on YouTube TV</a>`
      : ` &middot; <a href="${YTTV_WEB_URL}" target="_blank" rel="noopener" class="yttv-link">Watch on YouTube TV</a>`;
  }
  return `<div class="broadcast-line">\u{1F4FA} ${escapeHTML(e.broadcast)}${link}</div>`;
}

function teamNameHTML(team, sportKey){
  const label = escapeHTML(team.abbreviation || team.displayName);
  if(!team.id) return `<span class="n">${label}</span>`;
  return `<span class="n clickable" onclick="openTeamSchedule('${sportKey}','${team.id}')">${label}</span>`;
}

function modalSkeleton(e){
  return `
    <h2>${escapeHTML(e.away.displayName)} at ${escapeHTML(e.home.displayName)}</h2>
    <div class="sub">${statusLine(e)}</div>
    ${oddsLineHTML(e)}
    ${broadcastHTML(e)}
    <div class="modal-score-row">
      <div class="modal-team">${e.away.logo ? `<img src="${e.away.logo}" alt="">` : ""}${teamNameHTML(e.away, e.__sportKey)}</div>
      <div class="modal-score">${e.away.score ?? "\u2013"} &ndash; ${e.home.score ?? "\u2013"}</div>
      <div class="modal-team">${teamNameHTML(e.home, e.__sportKey)}${e.home.logo ? `<img src="${e.home.logo}" alt="">` : ""}</div>
    </div>
    <div class="tap-hint">Tap a team name for their season schedule</div>
    <div id="live-block"></div>
    <div class="modal-block"><h3>News</h3><div id="news-block" class="loading-line">Looking for stories\u2026</div></div>
    <div class="modal-block"><h3>Highlights</h3><div id="clips-block" class="loading-line">Looking for clips\u2026</div></div>
  `;
}

async function openGame(sportKey, id){
  const events = state.cache[sportKey] || [];
  const e = events.find((x) => String(x.id) === String(id));
  if(!e) return;
  state.activeGame = { sportKey, id };
  const overlay = document.getElementById("modal-overlay");
  document.getElementById("modal-body").innerHTML = modalSkeleton(e);
  overlay.classList.remove("hidden");

  loadGameExtras(sportKey, e);
  if(e.state === "in") startLivePolling(sportKey, id);
}

function closeModal(){
  document.getElementById("modal-overlay").classList.add("hidden");
  stopLivePolling();
  state.activeGame = null;
}

/* ----------------------------- team schedule ------------------------------ */

function formatShortDate(iso){
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function renderScheduleHTML(data, teamId){
  const teamName = (data.team && data.team.displayName) || "Team";
  const events = (data.events || []).slice().sort((a, b) => new Date(a.date) - new Date(b.date));

  let wins = 0, losses = 0, ties = 0;
  const rows = events.map((evt) => {
    const comp = (evt.competitions && evt.competitions[0]) || {};
    const competitors = comp.competitors || [];
    const us = competitors.find((c) => c.team && String(c.team.id) === String(teamId));
    const opp = competitors.find((c) => c !== us) || {};
    const statusType = (comp.status && comp.status.type) || {};
    const completed = !!statusType.completed;
    const oppTeam = opp.team || {};
    const oppName = oppTeam.displayName || oppTeam.name || "TBD";
    const atVs = us && us.homeAway === "away" ? "@" : "vs";

    if(completed){
      let resultTag = `<span class="res tie">T</span>`;
      if(us && us.winner){ wins++; resultTag = `<span class="res win">W</span>`; }
      else if(opp && opp.winner){ losses++; resultTag = `<span class="res loss">L</span>`; }
      else { ties++; }
      const usScore = us ? us.score : "";
      const oppScore = opp ? opp.score : "";
      return `<div class="sched-row">
        <span class="sched-date">${escapeHTML(formatShortDate(evt.date))}</span>
        <span class="sched-opp">${atVs} ${escapeHTML(oppName)}</span>
        <span class="sched-score">${resultTag}<span>${escapeHTML(String(usScore))}-${escapeHTML(String(oppScore))}</span></span>
      </div>`;
    }
    const timePart = formatLocalTime(evt.date).split("\u00b7")[1] || "";
    return `<div class="sched-row">
      <span class="sched-date">${escapeHTML(formatShortDate(evt.date))}</span>
      <span class="sched-opp">${atVs} ${escapeHTML(oppName)}</span>
      <span class="sched-score muted">${escapeHTML(timePart.trim())}</span>
    </div>`;
  }).join("");

  const record = `${wins}-${losses}${ties ? "-" + ties : ""}`;
  return `
    <button class="back-link" onclick="returnToGame()">&lsaquo; Back to game</button>
    <h2 style="margin-top:14px;">${escapeHTML(teamName)}</h2>
    <div class="sub">${escapeHTML(record)} this season</div>
    <div class="modal-block">${rows || '<div class="loading-line">No schedule found.</div>'}</div>
  `;
}

async function openTeamSchedule(sportKey, teamId){
  const conf = SPORTS[sportKey];
  const overlay = document.getElementById("modal-overlay");
  const body = document.getElementById("modal-body");
  stopLivePolling();
  overlay.classList.remove("hidden");
  body.innerHTML = `<button class="back-link" onclick="returnToGame()">&lsaquo; Back to game</button><div class="loading-line" style="margin-top:14px;">Loading schedule\u2026</div>`;
  try{
    const data = await fetchJSON(`${ESPN_BASE}/${conf.sport}/${conf.league}/teams/${teamId}/schedule`);
    body.innerHTML = renderScheduleHTML(data, teamId);
  } catch(err){
    console.error("schedule fetch failed", err);
    body.innerHTML = `<button class="back-link" onclick="returnToGame()">&lsaquo; Back to game</button><div class="empty-state">Couldn't load the schedule.</div>`;
  }
}

function returnToGame(){
  if(state.activeGame){
    openGame(state.activeGame.sportKey, state.activeGame.id);
  } else {
    closeModal();
  }
}

async function loadGameExtras(sportKey, e){
  const conf = SPORTS[sportKey];

  try{
    const newsData = await fetchJSON(`${ESPN_BASE}/${conf.sport}/${conf.league}/news?limit=25`);
    const homeLoc = (e.home.location || "").toLowerCase();
    const awayLoc = (e.away.location || "").toLowerCase();
    const arts = (newsData.articles || []).filter((a) => {
      const t = ((a.headline || "") + " " + (a.description || "")).toLowerCase();
      return (homeLoc && t.includes(homeLoc)) || (awayLoc && t.includes(awayLoc));
    }).slice(0, 5);
    const block = document.getElementById("news-block");
    if(block){
      block.innerHTML = arts.length
        ? arts.map((a) => `<a class="news-item" target="_blank" rel="noopener" href="${(a.links && a.links.web && a.links.web.href) || "#"}">${escapeHTML(a.headline)}<span class="src">${escapeHTML(a.source || "ESPN")}</span></a>`).join("")
        : `<div class="loading-line">No matching stories yet.</div>`;
    }
  } catch(err){
    console.error("news fetch failed", err);
    const block = document.getElementById("news-block");
    if(block) block.innerHTML = `<div class="loading-line">Couldn't load news.</div>`;
  }

  try{
    const summary = await fetchJSON(`${ESPN_BASE}/${conf.sport}/${conf.league}/summary?event=${e.id}`);
    const clipsBlock = document.getElementById("clips-block");
    const vids = summary.videos || summary.highlights || [];
    if(clipsBlock){
      clipsBlock.innerHTML = vids.length
        ? vids.slice(0, 6).map((v) => {
            const link = (v.links && (v.links.web?.href || v.links.source?.HD?.href || v.links.source?.mezzanine?.href || v.links.source?.full?.href)) || "#";
            return `<a class="clip-item" target="_blank" rel="noopener" href="${link}">${escapeHTML(v.headline || v.title || "Highlight clip")}<span class="src">${escapeHTML(v.source || "ESPN")}</span></a>`;
          }).join("")
        : `<div class="loading-line">No highlight clips yet.</div>`;
    }
    if(e.state === "in") renderLiveBlock(summary);
  } catch(err){
    console.error("summary fetch failed", err);
    const clipsBlock = document.getElementById("clips-block");
    if(clipsBlock) clipsBlock.innerHTML = `<div class="loading-line">Couldn't load clips.</div>`;
  }
}

function renderLiveBlock(summary){
  const liveBlock = document.getElementById("live-block");
  if(!liveBlock) return;
  const comp = summary.header && summary.header.competitions && summary.header.competitions[0];
  const statusDetail = (comp && comp.status && comp.status.type && comp.status.type.shortDetail) || "";
  const plays = summary.plays || [];
  const lastPlay = plays.length ? plays[plays.length - 1] : null;
  const lastText = (lastPlay && lastPlay.text) || (summary.situation && summary.situation.lastPlay && summary.situation.lastPlay.text) || "Score updating\u2026";
  liveBlock.innerHTML = `<div class="modal-block"><h3>Live updates</h3>
    <div class="live-line"><span class="sit">${escapeHTML(statusDetail)}</span>${escapeHTML(lastText)}</div>
  </div>`;
}

function startLivePolling(sportKey, id){
  stopLivePolling();
  livePollTimer = setInterval(async () => {
    try{
      const conf = SPORTS[sportKey];
      const summary = await fetchJSON(`${ESPN_BASE}/${conf.sport}/${conf.league}/summary?event=${id}`);
      renderLiveBlock(summary);
      const comp = summary.header && summary.header.competitions && summary.header.competitions[0];
      const liveState = comp && comp.status && comp.status.type && comp.status.type.state;
      if(liveState === "post"){
        stopLivePolling();
        fetchScoreboard(sportKey);
      }
    } catch(err){
      console.error("live poll failed", err);
    }
  }, 20000);
}

function stopLivePolling(){
  if(livePollTimer){ clearInterval(livePollTimer); livePollTimer = null; }
}

/* --------------------------------- init ---------------------------------- */

async function init(){
  if("serviceWorker" in navigator){
    navigator.serviceWorker.register("sw.js").catch((err) => console.error("SW registration failed", err));
  }
  renderTabsBar();
  await renderTab(getDefaultTab());
  setInterval(() => { if(!modalOpen()) fetchScoreboard(state.currentTab); }, 30000);
}

document.addEventListener("DOMContentLoaded", init);
