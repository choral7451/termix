# Termix

`cmux` 스타일의 멀티 세션 터미널 데스크탑 앱. Electron + xterm.js + node-pty 기반.

프로젝트 단위로 터미널 세션을 묶어 관리하고, 화면 분할·SSH 접속·프롬프트 저장·텍스트 검색을 지원한다.

## 특징

- **프로젝트별 분리** — 왼쪽 사이드바에서 프로젝트 단위로 세션을 묶어 관리한다. 프로젝트마다 이름·작업 폴더를 지정할 수 있고, 구성(이름·경로)은 앱을 재시작해도 유지된다.
- **멀티 세션** — 각 세션(탭)은 독립된 PTY(셸) 프로세스를 가진다. 한 세션의 작업이 다른 세션에 영향을 주지 않는다.
- **화면 분할** — 탭을 터미널 영역으로 드래그하면 상/하/좌/우로 분할된다. 경계를 드래그해 크기를 조절할 수 있다.
- **SSH 접속 목록** — 자주 쓰는 접속 명령을 등록해두고 클릭 한 번으로 활성 터미널에서 실행. 비밀번호를 저장해두면 `password` 프롬프트에 자동 입력된다.
- **프롬프트 저장** — 자주 쓰는 프롬프트/명령 텍스트를 저장해두고, 클릭하면 활성 터미널에 입력된다. "바로 실행" 옵션을 켜면 Enter까지 자동 입력.
- **텍스트 검색** — `Cmd/Ctrl + F` 로 현재 터미널 내용을 검색. 매치 강조 + 다음/이전 이동.
- **데스크탑 알림** — 터미널 벨(예: Claude Code 작업 완료)이나 OSC 9 알림을 받으면, 해당 세션을 보고 있지 않을 때 데스크탑 알림을 띄운다.
- **그 외** — 실제 셸 그대로 사용(`$SHELL` 자동 감지, 색상·링크·Nerd Font 지원), 자체 인라인 명령어 추천(셸 히스토리 기반), `Shift+Enter` 줄바꿈(Claude CLI 등), 창/탭 크기에 맞춘 자동 리사이즈.

> ⚠️ SSH 비밀번호는 이 컴퓨터의 사용자 데이터 폴더에 **평문**으로 저장된다. 가능하면 SSH 키 인증을 권장한다.

## 다운로드 (완성된 앱)

빌드 없이 바로 쓰려면 [**Releases**](https://github.com/choral7451/termix/releases/latest) 에서 `Termix-macOS-arm64.zip` 을 받으면 된다 (Apple Silicon 전용).

1. 압축 해제 후 `Termix.app` 을 **응용 프로그램** 폴더로 드래그
2. 서명되지 않은 앱이라 처음엔 Gatekeeper 가 막는다 → **우클릭 → 열기**, 또는:
   ```bash
   xattr -dr com.apple.quarantine /Applications/Termix.app
   ```

> Intel Mac 은 아래 소스에서 빌드한다.

## 실행 (개발)

```bash
npm install   # 의존성 설치 + node-pty 를 Electron 용으로 자동 리빌드
npm start
```

> node-pty 는 네이티브 모듈이라 Electron 버전에 맞춰 리빌드가 필요하다.
> `postinstall` 에서 자동 처리되며, 수동 실행은 `npm run rebuild`.

## 빌드 / 설치 (`.app`)

> 코드를 수정했으면 아래 명령으로 `/Applications/Termix.app` 을 다시 빌드·갱신한다.
> 그래야 더블클릭으로 실행하는 앱에 변경사항이 반영된다. (개발용 `npm start` 와 별개)

```bash
npm run deploy
```

`npm run deploy` 는 한 번에 다음을 수행한다 (`scripts/deploy.sh`):

1. `.app` 재빌드 (`electron-builder --mac --arm64`, 코드 서명 생략)
2. 실행 중인 `/Applications/Termix.app` 종료
3. 기존 앱 제거 후 새 빌드를 `/Applications` 로 복사

> Apple Silicon(arm64) 용으로 빌드된다. 서명하지 않은 개인용 앱이라 처음 실행 시 Gatekeeper 가 막으면 **우클릭 → 열기** 를 한 번만 하면 된다.

## 단축키

| 동작 | 키 |
| --- | --- |
| SSH·프롬프트 패널 토글 | `Cmd/Ctrl + O` |
| 터미널 텍스트 검색 | `Cmd/Ctrl + F` |
| 새 프로젝트 | `Cmd/Ctrl + N` |
| 새 세션 | `Cmd/Ctrl + T` |
| 현재 세션 닫기 | `Cmd/Ctrl + W` |
| N번째 세션으로 전환 | `Cmd/Ctrl + 1~9` |

- 프로젝트 **우클릭** → 이름 변경 / 경로 변경 / 삭제. **좌클릭** → 선택.
- 탭을 터미널 영역으로 **드래그** → 화면 분할.
- 검색 바: `Enter` 다음 매치 · `Shift+Enter` 이전 매치 · `Esc` 닫기.

## 구조

```
src/
  main.js              Electron 메인 — PTY 세션 · 프로젝트/SSH/프롬프트 영속화 · 폴더 다이얼로그
  preload.js           contextBridge 로 안전하게 노출되는 IPC API
  renderer/
    index.html
    renderer.js        프로젝트 사이드바 + 세션 탭 + 분할 레이아웃 + SSH/프롬프트 패널 + 검색 + xterm
    styles.css
scripts/
  deploy.sh            .app 재빌드 후 /Applications 갱신
```

세션 흐름: 렌더러에서 `termix.createSession({id, cwd})` → 메인이 `node-pty` 로 셸 spawn →
PTY 출력은 `session:data` 이벤트로 렌더러에 전달되어 해당 xterm 에 write,
xterm 입력은 `session:write` 로 PTY 에 전달.

사용자 데이터는 `~/Library/Application Support/termix/` 에 저장된다:

| 파일 | 내용 |
| --- | --- |
| `projects.json` | 프로젝트 구성(이름·작업 폴더) |
| `connections.json` | 등록한 SSH 접속 목록 (비밀번호 평문 포함 가능) |
| `prompts.json` | 저장한 프롬프트 |

## 기술 스택

- [Electron](https://www.electronjs.org/)
- [xterm.js](https://xtermjs.org/) (`@xterm/xterm` + fit / web-links / search 애드온)
- [node-pty](https://github.com/microsoft/node-pty)

## 라이선스

MIT
