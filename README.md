# 다시봄 (dasibom)

**서랍 속 헌 폰을 앱 설치 없이 AI 홈캠으로 되살리는 웹 서비스**

안 쓰는 스마트폰은 카메라·마이크·연산장치·화면·통신이 전부 달린 멀쩡한 컴퓨터입니다.
그런데 대부분 서랍에서 방전된 채 잠들어 있습니다. 홈캠은 따로 사면 5~10만원이고요.

다시봄은 **새 기기를 사지 않고**, **앱도 깔지 않고**, 브라우저 링크 하나로 그 폰을 되살립니다.

```
[헌 폰]  /cam   ──WebSocket──┐
                             ├── Durable Object ── Workers AI
[보는 쪽] /view ──WebSocket──┘
```

---

## 어떻게 쓰나

1. 첫 화면에서 **방 코드**를 만듭니다 (6자리).
2. **헌 폰**의 브라우저로 `/cam?room=코드` 를 열고 `감시 시작`.
3. **아이폰·노트북**에서 `/view?room=코드` 를 열면 실시간 화면과 활동 기록이 보입니다.

같은 코드를 넣은 기기끼리만 연결됩니다.

---

## 핵심 설계

### 1. 영상은 기본적으로 서버로 가지 않습니다
움직임 감지는 **폰 안에서** 처리합니다. 64×48로 축소한 프레임을 이전 프레임과 비교하는
차분 연산이라 구형 폰에서도 가볍게 돕니다.
서버로 전송되는 경우는 두 가지뿐입니다.

- 누군가 `/view`를 **보고 있을 때만** 미리보기 프레임 (2fps, 320px)
- **움직임·소리가 감지된 순간**의 스냅샷 1장 (최소 6초 간격)

보는 사람이 없으면 네트워크 트래픽이 사실상 0입니다.

### 2. 감지된 순간만 AI가 봅니다
스냅샷은 Durable Object를 거쳐 **Workers AI**로 갑니다.

- `@cf/facebook/detr-resnet-50` — 객체 인식 (사람/고양이/개…)
- `@cf/meta/llama-3.1-8b-instruct` — 활동 기록을 한국어 문장으로 요약

AI 호출은 **10초에 1회로 제한**해 무료 한도를 보호합니다. 실패해도 감지 기록은 그대로 남습니다.

### 3. 서버가 없습니다
Cloudflare Workers + Durable Objects(SQLite)로만 구성했습니다.
방 하나가 Durable Object 하나이고, WebSocket **Hibernation API**를 써서
아무도 안 볼 때는 메모리에서 내려갑니다. 관리할 서버도, 켜둘 인스턴스도 없습니다.

---

## 쓴 웹 표준 기능

| 기능 | 쓰임 |
|---|---|
| `getUserMedia` | 카메라·마이크 (전·후면 전환) |
| `enumerateDevices` | 여러 카메라 선택 |
| Canvas `getImageData` | 온디바이스 움직임 감지 |
| Web Audio `AnalyserNode` | 소리 크기 감지 (RMS) |
| **Screen Wake Lock** | 감시 중 화면 꺼짐 방지 |
| **Battery Status** | 폰 배터리 원격 확인 |
| `ImageCapture` torch | 플래시 원격 제어 (야간) |
| Screen Orientation | 세로 고정 |
| **WebSocket** | 실시간 양방향 |
| **Notification / Vibration** | 감지 알림 |
| Service Worker + Manifest | 홈 화면 설치(PWA) |
| Page Visibility | 백그라운드 복귀 시 Wake Lock 재획득 |

---

## 개발 · 배포

```bash
npm install
npm run dev      # http://localhost:8787
npm run deploy   # Cloudflare에 배포
```

배포하려면 먼저 `npx wrangler login` 으로 Cloudflare 계정에 로그인해야 합니다.

> **로컬 개발 주의**: Workers AI 바인딩은 원격 자원이라 `--local` 모드에서는
> `Binding AI needs to be run remotely` 오류가 납니다. 감지·기록은 정상 동작하고
> 객체 인식 라벨만 비는 상태가 되며, 배포 후에는 정상 동작합니다.

### 구조

```
src/index.js       Worker 라우팅 + Durable Object(Room)
public/index.html  랜딩 · 방 코드 발급
public/cam.html    카메라 모드 (헌 폰)
public/view.html   보기 모드
public/sw.js       서비스 워커
```

---

## 한계 (솔직하게)

- 영상은 WebRTC가 아니라 **JPEG 스냅샷 스트림**입니다. 화질·프레임이 낮은 대신
  NAT·방화벽 환경에서 TURN 서버 없이 어디서나 붙습니다. 홈캠 용도에는 이쪽이 안정적입니다.
- iOS 사파리는 백그라운드 카메라 제약이 커서 **카메라 역할은 안드로이드 권장**입니다.
  보는 쪽은 아이폰이든 데스크톱이든 상관없습니다.
- 방 코드만 알면 접속됩니다. 공개 배포 시 계정 인증을 붙여야 합니다.
- 객체 인식은 COCO 80종 기준이라 그 밖의 대상은 "움직임 감지"로만 기록됩니다.

## 라이선스

MIT
