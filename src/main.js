'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const https = require('https');
const pty = require('node-pty');

// 업데이트 확인 대상 레포 (GitHub Releases)
const REPO = 'choral7451/termix';

// 프로젝트 구성(이름·경로) 영속화 파일
const storeFile = () => path.join(app.getPath('userData'), 'projects.json');

// 세션 id -> { proc, win } 매핑. 각 세션은 독립된 PTY 프로세스를 가진다.
const sessions = new Map();

const isWin = os.platform() === 'win32';
const defaultShell = process.env.SHELL || (isWin ? 'powershell.exe' : '/bin/zsh');
// 로그인 셸로 띄워야 /etc/zprofile(path_helper) 등이 실행돼 brew 등 PATH 가 제대로 잡힌다.
// (GUI 앱은 최소 PATH 로 시작하므로 비로그인 셸이면 .zshrc 의 brew/nvm 호출이 실패한다)
const shellArgs = isWin ? [] : ['-l'];

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 600,
    minHeight: 400,
    backgroundColor: '#1e1e2e',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    title: 'Termix',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // 창이 닫히면 그 창에 속한 모든 세션을 정리한다.
  win.on('closed', () => {
    for (const [id, s] of sessions) {
      if (s.win === win) {
        try {
          s.proc.kill();
        } catch (_) {}
        sessions.delete(id);
      }
    }
  });

  return win;
}

// --- 세션 생성 ---
ipcMain.handle('session:create', (event, { id, cols, rows, cwd }) => {
  const win = BrowserWindow.fromWebContents(event.sender);

  const proc = pty.spawn(defaultShell, shellArgs, {
    name: 'xterm-color',
    cols: cols || 80,
    rows: rows || 24,
    cwd: cwd || os.homedir(),
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      // zsh-autosuggestions 추천 커맨드를 흐린 회색으로. (사용자 .zshrc 미수정,
      // 플러그인은 환경변수가 이미 설정돼 있으면 덮어쓰지 않으므로 우리 앱에서만 적용된다.)
      ZSH_AUTOSUGGEST_HIGHLIGHT_STYLE: 'fg=#585b70',
    },
  });

  proc.onData((data) => {
    if (!event.sender.isDestroyed()) {
      event.sender.send('session:data', { id, data });
    }
  });

  proc.onExit(({ exitCode, signal }) => {
    if (!event.sender.isDestroyed()) {
      event.sender.send('session:exit', { id, exitCode, signal });
    }
    sessions.delete(id);
  });

  sessions.set(id, { proc, win });
  return { id, pid: proc.pid, shell: defaultShell };
});

// --- 입력 쓰기 ---
ipcMain.on('session:write', (event, { id, data }) => {
  const s = sessions.get(id);
  if (s) s.proc.write(data);
});

// --- 리사이즈 ---
ipcMain.on('session:resize', (event, { id, cols, rows }) => {
  const s = sessions.get(id);
  if (s) {
    try {
      s.proc.resize(cols, rows);
    } catch (_) {}
  }
});

// --- 알림 클릭 시 창을 앞으로 ---
ipcMain.on('window:focus', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
  app.focus({ steal: true });
});

// --- 세션 종료 ---
ipcMain.on('session:kill', (event, { id }) => {
  const s = sessions.get(id);
  if (s) {
    try {
      s.proc.kill();
    } catch (_) {}
    sessions.delete(id);
  }
});

// --- 프로젝트 구성 저장/불러오기 ---
ipcMain.handle('projects:load', () => {
  try {
    return JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
  } catch (_) {
    return [];
  }
});

ipcMain.on('projects:save', (_event, list) => {
  try {
    fs.writeFileSync(storeFile(), JSON.stringify(list, null, 2));
  } catch (_) {}
});

// --- SSH 접속 목록(사용자 등록) 저장/불러오기 ---
const connFile = () => path.join(app.getPath('userData'), 'connections.json');

ipcMain.handle('connections:load', () => {
  try {
    return JSON.parse(fs.readFileSync(connFile(), 'utf8'));
  } catch (_) {
    return [];
  }
});

ipcMain.on('connections:save', (_event, list) => {
  try {
    fs.writeFileSync(connFile(), JSON.stringify(list, null, 2));
  } catch (_) {}
});

// --- 저장된 프롬프트 목록(사용자 등록) 저장/불러오기 ---
const promptFile = () => path.join(app.getPath('userData'), 'prompts.json');

ipcMain.handle('prompts:load', () => {
  try {
    return JSON.parse(fs.readFileSync(promptFile(), 'utf8'));
  } catch (_) {
    return [];
  }
});

ipcMain.on('prompts:save', (_event, list) => {
  try {
    fs.writeFileSync(promptFile(), JSON.stringify(list, null, 2));
  } catch (_) {}
});

// --- 전역 메모(자유 텍스트) 저장/불러오기 ---
const memoFile = () => path.join(app.getPath('userData'), 'memo.json');

ipcMain.handle('memo:load', () => {
  try {
    return JSON.parse(fs.readFileSync(memoFile(), 'utf8'));
  } catch (_) {
    return { text: '' };
  }
});

ipcMain.on('memo:save', (_event, data) => {
  try {
    fs.writeFileSync(memoFile(), JSON.stringify(data));
  } catch (_) {}
});

// --- 명령어 히스토리(자체 인라인 추천용) ---
ipcMain.handle('history:commands', () => {
  const home = os.homedir();
  const raw = [];
  for (const hf of ['.zsh_history', '.bash_history']) {
    try {
      const data = fs.readFileSync(path.join(home, hf), 'utf8');
      for (let line of data.split('\n')) {
        // zsh 확장 히스토리: ": <ts>:<dur>;<cmd>"
        if (line.startsWith(':')) {
          const semi = line.indexOf(';');
          if (semi !== -1) line = line.slice(semi + 1);
        }
        line = line.trim();
        if (line && !line.endsWith('\\')) raw.push(line); // 멀티라인 연속행은 제외
      }
    } catch (_) {}
  }
  // 최근 것 우선 + 중복 제거
  const seen = new Set();
  const out = [];
  for (const l of raw.reverse()) {
    if (!seen.has(l)) {
      seen.add(l);
      out.push(l);
    }
  }
  return out.slice(0, 3000);
});

// --- 업데이트 확인 (GitHub Releases 최신 버전) ---
function fetchLatestRelease() {
  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: 'api.github.com',
        path: `/repos/${REPO}/releases/latest`,
        method: 'GET',
        headers: { 'User-Agent': 'Termix-Updater', Accept: 'application/vnd.github+json' },
        timeout: 8000,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json && json.tag_name) resolve({ tag: json.tag_name, url: json.html_url });
            else resolve(null);
          } catch (_) {
            resolve(null);
          }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
}

ipcMain.handle('update:check', async () => {
  const latest = await fetchLatestRelease();
  return { current: app.getVersion(), latest };
});

ipcMain.handle('app:version', () => app.getVersion());

// --- 외부 링크 열기(기본 브라우저) ---
ipcMain.on('open:external', (_event, url) => {
  if (typeof url === 'string' && /^https:\/\//.test(url)) shell.openExternal(url);
});

// --- 프로젝트 작업 폴더 선택 ---
ipcMain.handle('dialog:pickFolder', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const res = await dialog.showOpenDialog(win, {
    title: '프로젝트 폴더 선택',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  return res.filePaths[0];
});

app.whenReady().then(() => {
  // 개발 모드(npm start)에서도 Dock 아이콘이 보이도록 설정.
  // (패키징된 .app 은 번들 아이콘을 자동 사용하므로 build/icon.png 가 없어 무시됨)
  if (!app.isPackaged && process.platform === 'darwin' && app.dock) {
    try {
      app.dock.setIcon(path.join(__dirname, '..', 'build', 'icon.png'));
    } catch (_) {}
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  for (const [, s] of sessions) {
    try {
      s.proc.kill();
    } catch (_) {}
  }
  sessions.clear();
  if (process.platform !== 'darwin') app.quit();
});
