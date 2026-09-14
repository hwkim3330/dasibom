/**
 * 다시봄 (dasibom) — 서랍 속 헌 폰을 AI 홈캠으로
 *
 * Cloudflare Worker + Durable Object(SQLite, 무료 플랜 지원) + Workers AI
 *
 *  [헌 폰]  /cam  ──WebSocket──┐
 *                              ├── Durable Object "Room" ── Workers AI (객체 인식 / 요약)
 *  [보는 쪽] /view ──WebSocket──┘
 */

const ROOM_RE = /^[A-Z0-9]{4,8}$/;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // ── 방 접속 (WebSocket) ────────────────────────────────
    const m = path.match(/^\/api\/room\/([^/]+)\/ws$/);
    if (m) {
      const code = decodeURIComponent(m[1]).toUpperCase();
      if (!ROOM_RE.test(code)) return json({ error: "잘못된 방 코드입니다." }, 400);
      const id = env.ROOM.idFromName(code);
      return env.ROOM.get(id).fetch(request);
    }

    // ── 방 이벤트 조회 (REST) ──────────────────────────────
    const m2 = path.match(/^\/api\/room\/([^/]+)\/(events|summary|clear)$/);
    if (m2) {
      const code = decodeURIComponent(m2[1]).toUpperCase();
      if (!ROOM_RE.test(code)) return json({ error: "잘못된 방 코드입니다." }, 400);
      const id = env.ROOM.idFromName(code);
      return env.ROOM.get(id).fetch(request);
    }

    // ── 새 방 코드 발급 ────────────────────────────────────
    if (path === "/api/new-room") {
      return json({ code: makeCode() });
    }

    // ── 정적 파일 ─────────────────────────────────────────
    return env.ASSETS.fetch(request);
  },
};

/* ────────────────────────────────────────────────────────────
 * Durable Object: 하나의 "방" = 헌 폰 1대 + 뷰어 N명
 * ──────────────────────────────────────────────────────────── */
export class Room {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.lastAiAt = 0;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname.endsWith("/events")) {
      return json({ events: await this.listEvents() });
    }
    if (url.pathname.endsWith("/clear")) {
      await this.ctx.storage.deleteAll();
      this.broadcast({ t: "cleared" });
      return json({ ok: true });
    }
    if (url.pathname.endsWith("/summary")) {
      return json(await this.makeSummary());
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("WebSocket 연결이 필요합니다.", { status: 426 });
    }

    const role = url.searchParams.get("role") === "cam" ? "cam" : "viewer";
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Hibernation API — 유휴 상태에서 과금/메모리 없이 연결 유지
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ role, joinedAt: Date.now() });

    // 접속 직후 현재 상태 전달
    const counts = this.counts();
    server.send(
      JSON.stringify({
        t: "welcome",
        role,
        counts,
        events: role === "viewer" ? await this.listEvents() : [],
      })
    );
    this.announce();

    return new Response(null, { status: 101, webSocket: client });
  }

  /* ── WebSocket 메시지 ─────────────────────────────── */
  async webSocketMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const att = ws.deserializeAttachment() || {};
    const role = att.role;

    switch (msg.t) {
      // 헌 폰 → 서버: 실시간 미리보기 프레임
      case "frame":
        if (role !== "cam") return;
        this.broadcastTo("viewer", { t: "frame", jpeg: msg.jpeg, ts: Date.now() });
        return;

      // 헌 폰 → 서버: 상태(배터리·해상도·카메라 방향 등)
      case "status":
        if (role !== "cam") return;
        await this.ctx.storage.put("camStatus", { ...msg.status, ts: Date.now() });
        this.broadcastTo("viewer", { t: "status", status: msg.status });
        return;

      // 헌 폰 → 서버: 움직임/소리 감지 → AI 분석 후 이벤트 저장
      case "detect":
        if (role !== "cam") return;
        await this.handleDetect(msg);
        return;

      // 뷰어 → 서버 → 헌 폰: 원격 명령
      case "cmd":
        if (role !== "viewer") return;
        this.broadcastTo("cam", { t: "cmd", cmd: msg.cmd, value: msg.value });
        return;

      case "ping":
        ws.send(JSON.stringify({ t: "pong", ts: Date.now() }));
        return;
    }
  }

  webSocketClose(ws) {
    this.announce();
  }
  webSocketError(ws) {
    this.announce();
  }

  /* ── 감지 처리 + Workers AI ────────────────────────── */
  async handleDetect(msg) {
    const now = Date.now();
    const ev = {
      id: `${now}-${Math.random().toString(36).slice(2, 7)}`,
      ts: now,
      kind: msg.kind || "motion", // motion | sound
      level: Math.round((msg.level || 0) * 100) / 100,
      jpeg: msg.jpeg || null,
      labels: [],
      text: "",
    };

    // 10초에 한 번만 AI 호출 (무료 한도 보호)
    const canAi = msg.jpeg && now - this.lastAiAt > 10_000;
    if (canAi) {
      this.lastAiAt = now;
      try {
        ev.labels = await this.detect(msg.jpeg);
      } catch (e) {
        ev.aiError = String(e).slice(0, 120);
      }
    }

    ev.text = describe(ev);
    await this.saveEvent(ev);
    this.broadcast({ t: "event", event: ev });
  }

  async detect(dataUrl) {
    if (!this.env.AI) return [];
    const bytes = dataUrlToBytes(dataUrl);
    const res = await this.env.AI.run("@cf/facebook/detr-resnet-50", {
      image: Array.from(bytes),
    });
    const out = Array.isArray(res) ? res : res?.result || [];
    return out
      .filter((o) => (o.score ?? 0) > 0.6)
      .slice(0, 6)
      .map((o) => ({ label: o.label, score: Math.round((o.score || 0) * 100) }));
  }

  async makeSummary() {
    const events = await this.listEvents();
    if (!events.length) return { text: "아직 기록된 활동이 없습니다." };

    const lines = events
      .slice(-30)
      .map((e) => `${hhmm(e.ts)} ${e.text}`)
      .join("\n");

    if (!this.env.AI) return { text: lines };
    try {
      const r = await this.env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
        messages: [
          {
            role: "system",
            content:
              "너는 가정용 카메라의 활동 기록을 한국어로 요약하는 비서다. 3문장 이내로, 시간대와 무엇이 감지되었는지 자연스럽게 정리해라. 추측하지 말고 기록에 있는 내용만 말해라.",
          },
          { role: "user", content: `활동 기록:\n${lines}` },
        ],
        max_tokens: 300,
      });
      const text = (r?.response || "").trim();
      return { text: text || lines, raw: lines };
    } catch (e) {
      return { text: lines, error: String(e).slice(0, 120) };
    }
  }

  /* ── 저장 (최근 40건 유지) ─────────────────────────── */
  async saveEvent(ev) {
    await this.ctx.storage.put(`ev:${ev.ts}:${ev.id}`, ev);
    const keys = [...(await this.ctx.storage.list({ prefix: "ev:" })).keys()];
    if (keys.length > 40) {
      await this.ctx.storage.delete(keys.slice(0, keys.length - 40));
    }
  }

  async listEvents() {
    const map = await this.ctx.storage.list({ prefix: "ev:" });
    return [...map.values()].sort((a, b) => a.ts - b.ts);
  }

  /* ── 브로드캐스트 유틸 ─────────────────────────────── */
  sockets(role) {
    return this.ctx.getWebSockets().filter((ws) => {
      if (!role) return true;
      const a = ws.deserializeAttachment() || {};
      return a.role === role;
    });
  }
  counts() {
    return { cam: this.sockets("cam").length, viewer: this.sockets("viewer").length };
  }
  broadcast(obj) {
    const s = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(s); } catch {}
    }
  }
  broadcastTo(role, obj) {
    const s = JSON.stringify(obj);
    for (const ws of this.sockets(role)) {
      try { ws.send(s); } catch {}
    }
  }
  announce() {
    this.broadcast({ t: "counts", counts: this.counts() });
  }
}

/* ── 헬퍼 ─────────────────────────────────────────────── */
const KO = {
  person: "사람", cat: "고양이", dog: "개", bird: "새",
  "cell phone": "휴대폰", laptop: "노트북", tv: "TV", book: "책",
  chair: "의자", couch: "소파", "potted plant": "화분", bed: "침대",
  "dining table": "식탁", bottle: "병", cup: "컵", backpack: "가방",
  handbag: "가방", umbrella: "우산", car: "자동차", bicycle: "자전거",
  clock: "시계", scissors: "가위", remote: "리모컨", keyboard: "키보드",
};

function describe(ev) {
  if (ev.kind === "sound") return `소리 감지 (크기 ${Math.round(ev.level * 100)}%)`;
  const people = ev.labels.filter((l) => l.label === "person").length;
  const others = ev.labels.filter((l) => l.label !== "person");
  if (people > 0) {
    const extra = others.length ? `, ${others.map((o) => KO[o.label] || o.label).join("·")}` : "";
    return `사람 ${people}명 감지${extra}`;
  }
  if (others.length) return `${others.map((o) => KO[o.label] || o.label).join("·")} 감지`;
  return "움직임 감지";
}

function hhmm(ts) {
  const d = new Date(ts + 9 * 3600 * 1000); // KST
  const h = d.getUTCHours();
  const ap = h < 12 ? "오전" : "오후";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${ap} ${h12}시 ${String(d.getUTCMinutes()).padStart(2, "0")}분`;
}

function dataUrlToBytes(dataUrl) {
  const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function makeCode() {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 헷갈리는 글자 제외
  let s = "";
  for (let i = 0; i < 6; i++) s += A[Math.floor(Math.random() * A.length)];
  return s;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
