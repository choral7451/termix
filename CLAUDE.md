# CLAUDE.md

Termix — `cmux` 스타일 멀티 세션 터미널 데스크탑 앱 (Electron + xterm.js + node-pty).

## ⚠️ 필수 규칙: 코드 변경 시 항상 .app 갱신

**소스(`src/**`, `package.json`, `scripts/**`)를 수정했으면, 작업을 마치기 전에 반드시 `.app` 을 재빌드하고 `/Applications` 에 갱신한다.**

```bash
npm run deploy
```

- 사용자는 `/Applications/Termix.app` 을 더블클릭해 앱을 쓴다. 재빌드하지 않으면 변경사항이 반영되지 않는다.
- `npm run deploy` = `.app` 재빌드 → 실행 중인 앱 종료 → `/Applications/Termix.app` 교체 (`scripts/deploy.sh`).
- UI/로직만 빠르게 확인할 때는 `npm start` (개발 모드) 를 쓰되, **마무리 단계에서는 항상 `npm run deploy` 로 배포본까지 갱신**한다.

## 개발 메모

- node-pty 는 네이티브 모듈 → Electron 용 리빌드 필요 (`postinstall`/`npm run rebuild` 가 처리).
- xterm 본체/애드온은 UMD 빌드라 `<script>` 로 로드해 전역 사용. 본체는 `window.Terminal`, 애드온은 `window.FitAddon.FitAddon` 처럼 한 단계 안쪽.
- 터미널 fit 은 pane 이 화면에 보일 때(크기 > 0) 해야 한다 → `ResizeObserver` 로 처리.
- 프로젝트 구성은 `~/Library/Application Support/termix/projects.json` 에 영속화.
- 변경 검증: `npm start` 로 띄운 뒤 메인 stdout 로그(`/tmp/termix.log`)에서 렌더러 에러 확인.
