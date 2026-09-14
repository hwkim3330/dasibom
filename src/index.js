/**
 * 다시봄 (dasibom) — 말로 설정하는 AI 홈캠
 *
 * "고양이가 식탁에 올라가면 알려줘" 라고 한국어로 쓰면,
 * 비전 언어 모델이 카메라 화면을 보고 그 조건이 맞을 때만 알립니다.
 *
 * Cloudflare Worker + Durable Object(SQLite) + Workers AI
 *
 *   [헌 폰]  /cam  ──WS──┐
 *                        ├── Durable Object "Room" ── Workers AI (VLM 판정 / 장면 서술)
 *   [보는 쪽] /view ──WS──┘
 */

const ROOM_RE = /^[A-Z0-9]{4,8}$/;

// 비전 모델: 1순위 Qwen 3.8 27B (비전·한국어 우수) → 실패 시 Llama 4 Scout
const VLM_PRIMARY = "@cf/qwen/qwen3.8-27b";
const VLM_FALLBACK = "@cf/meta/llama-4-scout-17b-16e-instruct";
// 텍스트 요약 모델
const TEXT_MODEL = "@cf/qwen/qwen3-30b-a3b-fp8";

const AI_COOLDOWN_MS = 12_000; // 무료 한도 보호
const MAX_EVENTS = 40;
const MAX_RULES = 5;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const m = url.pathname.match(
      /^\/api\/room\/([^/]+)\/(ws|events|rules|summary|clear)$/
    );
    if (m) {
      const code = decodeURIComponent(m[1]).toUpperCase();
      if (!ROOM_RE.test(code)) return json({ error: "잘못된 방 코드입니다." }, 400);
      return env.ROOM.get(env.ROOM.idFromName(code)).fetch(request);
    }
    if (url.pathname === "/api/new-room") return json({ code: makeCode() });
    return env.ASSETS.fetch(request);
  },
};

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.lastAiAt = 0;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const p = url.pathname;

    if (p.endsWith("/events")) return json({ events: await this.listEvents() });
    if (p.endsWith("/summary")) return json(await this.makeSummary());
    if (p.endsWith("/clear")) {
      for (const k of (await this.ctx.storage.list({ prefix: "ev:" })).keys()) {
        await this.ctx.storage.delete(k);
      }
      this.broadcast({ t: "cleared" });
      return json({ ok: true });
    }
    if (p.endsWith("/rules")) {
      if (request.method === "PUT") {
        const body = await request.json().catch(() => ({}));
        const rules = sanitizeRules(body.rules);
        await this.ctx.storage.put("rules", rules);
        this.broadcast({ t: "rules", rules });
        return json({ rules });
      }
      return json({ rules: await this.getRules() });
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("WebSocket 연결이 필요합니다.", { status: 426 });
    }

    const role = url.searchParams.get("role") === "cam" ? "cam" : "viewer";
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server); // Hibernation API
    server.serializeAttachment({ role });

    server.send(
      JSON.stringify({
        t: "welcome",
        role,
        counts: this.counts(),
        rules: await this.getRules(),
        events: role === "viewer" ? await this.listEvents() : [],
      })
    );
    this.announce();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const role = (ws.deserializeAttachment() || {}).role;

    if (msg.t === "frame" && role === "cam")
      return this.broadcastTo("viewer", { t: "frame", jpeg: msg.jpeg, ts: Date.now() });

    if (msg.t === "status" && role === "cam") {
      await this.ctx.storage.put("camStatus", { ...msg.status, ts: Date.now() });
      return this.broadcastTo("viewer", { t: "status", status: msg.status });
    }

    if (msg.t === "detect" && role === "cam") return this.handleDetect(msg);

    if (msg.t === "cmd" && role === "viewer")
      return this.broadcastTo("cam", { t: "cmd", cmd: msg.cmd, value: msg.value });

    if (msg.t === "ping") ws.send(JSON.stringify({ t: "pong", ts: Date.now() }));
  }

  webSocketClose() { this.announce(); }
  webSocketError() { this.announce(); }

  /* ── 감지 → AI 판정 ─────────────────────────────── */
  async handleDetect(msg) {
    const now = Date.now();
    const rules = await this.getRules();
    const active = rules.filter((r) => r.enabled);

    const ev = {
      id: `${now}-${Math.random().toString(36).slice(2, 7)}`,
      ts: now,
      kind: msg.kind || "motion",
      level: Math.round((msg.level || 0) * 100) / 100,
      jpeg: msg.jpeg || null,
      onDevice: Array.isArray(msg.labels) ? msg.labels.slice(0, 6) : null, // 폰에서 1차 판별한 결과
      local: false, // true면 판정까지 기기 안에서 끝났다는 뜻
      alert: false,
      rule: null,
      text: msg.kind === "sound" ? `소리 감지 (크기 ${Math.round((msg.level || 0) * 100)}%)` : "움직임 감지",
      model: null,
    };

    // ── 기기에서 온디바이스 VLM이 이미 판정한 경우: 클라우드 호출 없음 ──
    if (msg.verdict && typeof msg.verdict === "object") {
      const v = msg.verdict;
      const idx = Number(v.rule);
      const matched = v.match === true && idx >= 1 && idx <= active.length;
      ev.alert = !!matched;
      ev.rule = matched ? active[idx - 1].text : null;
      ev.text = String(v.text || ev.text).slice(0, 200);
      ev.model = String(v.model || "on-device").slice(0, 60);
      ev.local = true; // 영상이 서버로 나가지 않았음을 표시
      await this.saveEvent(ev);
      this.broadcast({ t: "event", event: ev });
      return;
    }

    const canAi = msg.jpeg && now - this.lastAiAt > AI_COOLDOWN_MS && this.env.AI;
    if (canAi) {
      this.lastAiAt = now;
      try {
        const r = active.length
          ? await this.judge(msg.jpeg, active, ev.onDevice)
          : await this.describe(msg.jpeg, ev.onDevice);
        Object.assign(ev, r);
      } catch (e) {
        ev.aiError = String(e).slice(0, 140);
      }
    } else if (active.length && msg.jpeg) {
      // 쿨다운 중이라 이번 장면은 AI가 보지 못했음 (소리 전용 이벤트는 원문 유지)
      ev.text = "움직임 감지 (AI 판독 대기)";
    }

    await this.saveEvent(ev);
    this.broadcast({ t: "event", event: ev });
  }

  /** 사용자가 한국어로 쓴 규칙에 화면이 부합하는지 VLM이 판정 */
  async judge(dataUrl, rules, onDevice) {
    const list = rules.map((r, i) => `${i + 1}. ${r.text}`).join("\n");
    const hint = hintLine(onDevice);
    const sys =
      "너는 가정용 감시 카메라의 판독기다. 사진을 보고, 사용자가 정한 알림 조건 중 " +
      "실제로 충족된 것이 있는지 판단한다. 보이지 않는 것을 추측하지 마라. " +
      '반드시 JSON만 출력한다: {"match": true|false, "rule": 번호 또는 null, "text": "한국어 한 문장"}. ' +
      "match가 false면 text에는 화면에 보이는 것을 짧게 한국어로 적는다.";
    const user =
      `알림 조건:\n${list}\n${hint}\n\n이 사진이 위 조건 중 하나라도 충족하는가?`;

    const out = await this.callVlm(dataUrl, sys, user);
    const parsed = parseJson(out.text);
    const idx = Number(parsed?.rule);
    const matched = parsed?.match === true && idx >= 1 && idx <= rules.length;
    return {
      alert: !!matched,
      rule: matched ? rules[idx - 1].text : null,
      text: (parsed?.text || out.text || "판독 실패").slice(0, 200),
      model: out.model,
    };
  }

  /** 규칙이 없으면 장면을 한국어 한 문장으로 서술 */
  async describe(dataUrl, onDevice) {
    const sys =
      "너는 가정용 감시 카메라의 판독기다. 사진에 보이는 것을 한국어 한 문장으로 " +
      "짧고 사실만 담아 설명한다. 추측하지 말고 보이는 것만 말해라. 설명 외 다른 말은 하지 마라.";
    const out = await this.callVlm(
      dataUrl,
      sys,
      `이 사진에 무엇이 보이는가?${hintLine(onDevice)}`
    );
    return { text: (out.text || "장면 판독 실패").slice(0, 200), model: out.model };
  }

  async callVlm(dataUrl, sys, user) {
    // 1순위: 네이티브 멀티모달 (messages + image_url)
    try {
      const r = await this.env.AI.run(VLM_PRIMARY, {
        messages: [
          { role: "system", content: sys },
          {
            role: "user",
            content: [
              { type: "text", text: user },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
        max_tokens: 220,
      });
      const text = stripThink(r?.response ?? r?.result?.response ?? "");
      if (text) return { text, model: VLM_PRIMARY };
    } catch (_) {}

    // 2순위: Llama 4 Scout (네이티브 멀티모달)
    const r2 = await this.env.AI.run(VLM_FALLBACK, {
      messages: [
        { role: "system", content: sys },
        {
          role: "user",
          content: [
            { type: "text", text: user },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
      max_tokens: 220,
    });
    return { text: stripThink(r2?.response ?? r2?.result?.response ?? ""), model: VLM_FALLBACK };
  }

  async makeSummary() {
    const events = await this.listEvents();
    if (!events.length) return { text: "아직 기록된 활동이 없습니다." };
    const lines = events.slice(-30).map((e) => `${hhmm(e.ts)} ${e.alert ? "[알림] " : ""}${e.text}`).join("\n");
    if (!this.env.AI) return { text: lines };
    try {
      const r = await this.env.AI.run(TEXT_MODEL, {
        messages: [
          {
            role: "system",
            content:
              "가정용 카메라의 활동 기록을 한국어 3문장 이내로 요약하는 비서다. " +
              "시간대와 무엇이 감지되었는지 자연스럽게 정리하고, 기록에 없는 내용은 절대 지어내지 마라.",
          },
          { role: "user", content: `활동 기록:\n${lines}` },
        ],
        max_tokens: 300,
      });
      return { text: stripThink(r?.response || "") || lines, raw: lines };
    } catch (e) {
      return { text: lines, error: String(e).slice(0, 120) };
    }
  }

  /* ── 저장 ────────────────────────────────────────── */
  async getRules() {
    return (await this.ctx.storage.get("rules")) || [];
  }
  async saveEvent(ev) {
    await this.ctx.storage.put(`ev:${ev.ts}:${ev.id}`, ev);
    const keys = [...(await this.ctx.storage.list({ prefix: "ev:" })).keys()];
    if (keys.length > MAX_EVENTS) {
      for (const k of keys.slice(0, keys.length - MAX_EVENTS)) await this.ctx.storage.delete(k);
    }
  }
  async listEvents() {
    return [...(await this.ctx.storage.list({ prefix: "ev:" })).values()].sort((a, b) => a.ts - b.ts);
  }

  /* ── 소켓 ────────────────────────────────────────── */
  sockets(role) {
    return this.ctx.getWebSockets().filter((ws) =>
      !role ? true : (ws.deserializeAttachment() || {}).role === role
    );
  }
  counts() {
    return { cam: this.sockets("cam").length, viewer: this.sockets("viewer").length };
  }
  broadcast(o) {
    const s = JSON.stringify(o);
    for (const ws of this.ctx.getWebSockets()) { try { ws.send(s); } catch {} }
  }
  broadcastTo(role, o) {
    const s = JSON.stringify(o);
    for (const ws of this.sockets(role)) { try { ws.send(s); } catch {} }
  }
  announce() { this.broadcast({ t: "counts", counts: this.counts() }); }
}

/* ── 헬퍼 ──────────────────────────────────────────── */
function sanitizeRules(input) {
  if (!Array.isArray(input)) return [];
  return input
    .filter((r) => r && typeof r.text === "string" && r.text.trim())
    .slice(0, MAX_RULES)
    .map((r, i) => ({
      id: String(r.id || i + 1),
      text: r.text.trim().slice(0, 120),
      enabled: r.enabled !== false,
    }));
}

/** Qwen3 등의 사고 과정(<think>…</think>) 제거 */
function stripThink(s) {
  return String(s || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<\/?think>/gi, "")
    .trim();
}

/** 모델이 코드펜스나 설명을 섞어 내놔도 JSON을 건져낸다 */
function parseJson(s) {
  if (!s) return null;
  const cleaned = s.replace(/```json|```/g, "");
  const a = cleaned.indexOf("{"), b = cleaned.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(cleaned.slice(a, b + 1)); } catch { return null; }
}

/** 폰에서 1차로 잡아낸 라벨을 모델에게 참고로만 넘긴다 (단정하지 않도록 표현) */
function hintLine(onDevice) {
  if (!onDevice || !onDevice.length) return "";
  const items = onDevice.map((o) => `${o.label}(${o.score}%)`).join(", ");
  return `\n참고: 기기에서 1차 탐지된 후보는 [${items}] 이다. 틀릴 수 있으니 사진을 직접 보고 판단하라.`;
}

function hhmm(ts) {
  const d = new Date(ts + 9 * 3600 * 1000); // KST
  const h = d.getUTCHours();
  return `${h < 12 ? "오전" : "오후"} ${h % 12 === 0 ? 12 : h % 12}시 ${String(d.getUTCMinutes()).padStart(2, "0")}분`;
}

function dataUrlToBytes(dataUrl) {
  const bin = atob(dataUrl.slice(dataUrl.indexOf(",") + 1));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function makeCode() {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 6 }, () => A[Math.floor(Math.random() * A.length)]).join("");
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
