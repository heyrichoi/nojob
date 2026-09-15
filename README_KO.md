# CHZZK 파티 후원 TTS + Google Sheets 벌금표 v5

이번 버전은 **스트리머 PC에 별도 프로그램을 설치하지 않는 중앙 서버 방식**입니다.

스트리머 8명에게는 모두 **같은 OBS 브라우저 소스 주소 하나**만 전달하면 됩니다.

```text
https://내-서버주소/overlay
```

관리/벌금 업다운은:

```text
https://내-서버주소/control
```

## 최종 구조

```text
CHZZK 8개 채널의 실시간 채팅/파티 이벤트
               ↓
          중앙 Node 서버
          ├ PARTY(type 13) 감지
          ├ 중복 이벤트 제거
          ├ Typecast TTS 1회 생성
          ├ 8개 OBS에 같은 음성 스트림 전달
          └ Google Sheets 벌금표 중계
               ↓
       /overlay (8명 모두 동일)
```

치지직 파티 후원 알림이 8명에게 동시에 보이더라도 서버가 **같은 이벤트를 1건으로 중복 제거**한 뒤 Typecast API를 한 번만 호출합니다.

---

## 1. Google Sheets 구조

현재 만든 시트 구조 그대로 사용합니다.

| 위치 | 내용 |
|---|---|
| A2:A | 닉네임 |
| B2:B | 횟수 |
| D2 | 1회당 금액 |
| E2 | 금액 뒤에 붙을 단위 |

예: D2 = `10000`, E2 = `골드`, B열 = `8` → 오버레이에 `8만 골드`

### Apps Script 설정

1. 시트에서 **확장 프로그램 → Apps Script**
2. 기본 `Code.gs` 내용을 모두 지움
3. `google_apps_script/Code.gs` 전체 붙여넣기
4. Apps Script 상단 함수 선택에서 `setup`을 1회 실행 → 권한 승인
5. **배포 → 새 배포 → 웹 앱**
6. 실행 사용자: 본인
7. 접근 권한: 서버에서 로그인 없이 읽을 수 있도록 설정
8. 배포 후 `/exec` URL을 복사
9. 서버 환경변수 `SHEET_WEBAPP_URL`에 넣기

컨트롤 PIN은 없습니다.

---

## 2. Typecast 설정

Typecast API 키는 **절대로 OBS HTML/브라우저 코드에 넣지 않고 중앙 서버 환경변수에만 저장**합니다.

필수:

```text
TYPECAST_API_KEY=...
TYPECAST_VOICE_ID=tc_...
```

새 프로젝트 권장 모델인 `ssfm-v30`, 한국어 `kor`, MP3 Streaming TTS를 기본 사용합니다.

보이스 ID는 Typecast API Voice Library에서 선택합니다.

```text
https://studio.typecast.ai/developers/api/voices
```

이 프로젝트의 Typecast attribution은 생성 코드에 다음 값으로 고정되어 있습니다.

```text
source=api-page
generated_by=chatgpt
```

`source=api-page`는 사용자가 Typecast API 페이지에서 복사한 통합 프롬프트의 지시에 따른 값이며, `generated_by=chatgpt`는 이 통합 코드를 작성한 코딩 에이전트의 안정적인 소문자 식별자입니다.

### 기본 TTS 동작

파티 후원:

```text
강초해님 / 10,000 / 제발 다 사다리 좀 차주세요 제발
```

기본값에서는 **메시지만** 읽습니다.

```text
제발 다 사다리 좀 차주세요 제발
```

원하면 `.env`에서 변경할 수 있습니다.

```text
TTS_READ_DONOR=true
TTS_READ_AMOUNT=true
```

---

## 3. CHZZK 8개 채널 등록

각 스트리머의 **채널 ID(채널 해시)** 를 쉼표로 넣습니다.

```text
CHZZK_CHANNEL_IDS=채널ID1,채널ID2,채널ID3,채널ID4,채널ID5,채널ID6,채널ID7,채널ID8
```

서버는 각 채널의 읽기 전용 실시간 채팅 소켓에 연결하고, raw 메시지에서 파티 메시지 타입 `13`을 감지합니다.

파티 후원은 공식 Open API의 `DONATION` 명세에 별도 PARTY 타입이 문서화되어 있지 않기 때문에 이 부분은 **치지직 웹 클라이언트가 사용하는 비공식 실시간 채팅 데이터에 의존**합니다. 치지직이 내부 구조를 변경하면 파서 수정이 필요할 수 있습니다.

이를 위해 기본값으로 실제 PARTY 패킷을 다음 파일에 기록합니다.

```text
logs/party-raw.jsonl
```

실방 테스트 1건 후 이 파일에 `type 13` 패킷이 잡히는지 확인하면 가장 안전합니다. 민감한 채팅 데이터가 저장되는 것이 싫다면:

```text
PARTY_DEBUG_LOG=false
```

로 끌 수 있습니다.

---

## 4. 서버 실행

Node.js 20 이상 권장.

```bash
cp .env.example .env
# .env 값 입력
npm install
npm start
```

로컬 테스트:

```text
http://localhost:3000/control
http://localhost:3000/overlay
```

`/control`에서 **TTS 테스트** 버튼을 먼저 눌러 Typecast → 서버 → 브라우저 음성 재생을 확인하세요.

---

## 5. OBS 설정

브라우저 소스 URL:

```text
https://내-서버주소/overlay
```

모든 스트리머에게 **동일 주소**를 전달합니다.

권장:

- 너비: 420
- 높이: 450
- `OBS를 통해 오디오 제어` 켜기
- OBS 오디오 믹서에서 브라우저 소스 볼륨 조절

벌금표가 필요 없는 장면에서도 TTS만 유지하고 싶다면 같은 브라우저 소스를 작은 크기로 유지하거나, 추후 `audio-only` 모드를 추가할 수 있습니다.

디버그 화면:

```text
https://내-서버주소/overlay?debug=1
```

파티 TTS 이벤트와 연결 상태가 하단에 텍스트로 표시됩니다.

---

## 6. 클라우드에 올릴 때

이 기능은 CHZZK 실시간 소켓을 계속 감시해야 하므로 **서버 프로세스가 켜져 있어야 합니다.**

적합한 형태:

- Railway / Fly.io / Render의 항상 켜지는 유료 인스턴스
- 개인 VPS
- 24시간 켜진 PC에서 Node 서버 실행 + 터널/도메인

무료 인스턴스가 자동 절전되는 서비스는 방송 중 연결이 끊길 수 있어 권장하지 않습니다.

Dockerfile과 `render.yaml`을 같이 넣었습니다.

---

## 7. 실방 전 체크 순서

1. `/control`에서 `Typecast 연결 준비` 확인
2. CHZZK `8/8` 또는 방송 중인 채널 수만큼 연결 확인
3. 벌금표 버튼 `+1` → 시트 B열과 OBS 둘 다 변경되는지 확인
4. `TTS 테스트` → OBS 믹서에서 소리가 나오는지 확인
5. 실제 파티 후원 1건 테스트
6. `logs/party-raw.jsonl`에 PARTY 패킷 기록 확인
7. 같은 후원이 OBS에서 한 번만 읽히는지 확인

---

## 참고: 왜 OCR을 제거했나

화면 OCR 방식은 스트리머 PC 화면을 직접 읽어야 해서 8명 모두 별도 프로그램을 실행해야 합니다. 현재 구조는 중앙 서버가 CHZZK 실시간 데이터를 읽고 Typecast TTS를 만든 뒤, OBS 브라우저 소스에 전달하므로 스트리머는 링크만 등록하면 됩니다.
