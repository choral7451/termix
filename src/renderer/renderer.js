// xterm 및 애드온은 index.html에서 UMD 스크립트로 로드되어 전역에 노출된다.
// 본체는 window.Terminal 이 곧 클래스지만, 애드온은 네임스페이스 한 단계 안쪽에 클래스가 있다.
const Terminal = window.Terminal;
const FitAddon = window.FitAddon.FitAddon;
const WebLinksAddon = window.WebLinksAddon.WebLinksAddon;
const SearchAddon = window.SearchAddon.SearchAddon;

const THEME = {
  background: '#1e1e2e',
  foreground: '#cdd6f4',
  cursor: '#f5e0dc',
  selectionBackground: '#585b70',
  black: '#45475a',
  red: '#f38ba8',
  green: '#a6e3a1',
  yellow: '#f9e2af',
  blue: '#89b4fa',
  magenta: '#f5c2e7',
  cyan: '#94e2d5',
  white: '#bac2de',
  brightBlack: '#585b70',
  brightRed: '#f38ba8',
  brightGreen: '#a6e3a1',
  brightYellow: '#f9e2af',
  brightBlue: '#89b4fa',
  brightMagenta: '#f5c2e7',
  brightCyan: '#94e2d5',
  brightWhite: '#a6adc8',
};

// ===== 상태 =====
// 프로젝트: pid -> { id, name, cwd, sessionIds[], activeSessionId, el, nameEl, countEl, pathEl }
// 세션:    sid -> { id, projectId, term, fit, pane, tab, dispose[] }
const projects = new Map();
const sessions = new Map();
let activeProjectId = null;
let activeSessionId = null;
let projCounter = 0;
let sessCounter = 0;

const projectsEl = document.getElementById('projects');
const tabsEl = document.getElementById('tabs');
const panesEl = document.getElementById('terminals');

const HOME = '~'; // 표시용. 실제 cwd 미지정 시 메인이 홈으로 spawn.

function shortPath(p) {
  if (!p) return '~ (홈)';
  return p.replace(/^\/Users\/[^/]+/, '~');
}

// ===== 컨텍스트 메뉴 =====
let ctxEl = null;
function hideContextMenu() {
  if (ctxEl) {
    ctxEl.remove();
    ctxEl = null;
  }
}
function showContextMenu(x, y, items) {
  hideContextMenu();
  ctxEl = document.createElement('div');
  ctxEl.className = 'ctx-menu';
  items.forEach((it) => {
    if (it.sep) {
      const s = document.createElement('div');
      s.className = 'ctx-sep';
      ctxEl.appendChild(s);
      return;
    }
    const item = document.createElement('div');
    item.className = 'ctx-item' + (it.danger ? ' danger' : '');
    item.textContent = it.label;
    item.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      hideContextMenu();
      it.action();
    });
    ctxEl.appendChild(item);
  });
  document.body.appendChild(ctxEl);
  // 화면 밖으로 넘어가지 않게 위치 보정
  const r = ctxEl.getBoundingClientRect();
  ctxEl.style.left = Math.min(x, window.innerWidth - r.width - 4) + 'px';
  ctxEl.style.top = Math.min(y, window.innerHeight - r.height - 4) + 'px';
}
// 메뉴 바깥 클릭/Esc/스크롤 시 닫기
window.addEventListener('mousedown', (e) => {
  if (ctxEl && !ctxEl.contains(e.target)) hideContextMenu();
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideContextMenu();
});
window.addEventListener('blur', hideContextMenu);

// 현재 프로젝트 구성(이름·경로)을 순서대로 디스크에 저장한다.
function persist() {
  const list = [...projects.values()].map((p) => ({ name: p.name, cwd: p.cwd }));
  window.termix.saveProjects(list);
}

// ===== 데스크탑 알림 =====
if ('Notification' in window && Notification.permission === 'default') {
  Notification.requestPermission();
}

// 세션이 주의를 요청할 때(벨/알림 시퀀스) 데스크탑 알림을 띄운다.
// 이미 그 세션을 보고 있고 창도 포커스돼 있으면(=눈으로 보는 중) 알림은 생략한다.
function notifySession(id, message) {
  const s = sessions.get(id);
  if (!s) return;
  const focusedHere = document.hasFocus() && activeSessionId === id;
  if (focusedHere) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;

  const proj = projects.get(s.projectId);
  const label = s.tab.querySelector('.label');
  const sessName = label ? label.textContent : '세션';
  const title = proj ? `${proj.name} · ${sessName}` : sessName;

  const n = new Notification(title, {
    body: message || '작업 알림',
    silent: false,
  });
  n.onclick = () => {
    window.termix.focusWindow();
    if (proj && activeProjectId !== proj.id) selectProject(proj.id);
    setActiveSession(id);
    n.close();
  };

  // 탭에 시각적 미확인 표시
  s.tab.classList.add('attention');
}

// ===== 자체 인라인 명령어 추천 (zsh-autosuggestions 없이도 동작) =====
// 최근 것 우선. 셸 히스토리로 시드 후, Termix 에서 실행한 명령을 앞에 누적.
let cmdHistory = [];

function recordCommand(cmd) {
  const i = cmdHistory.indexOf(cmd);
  if (i !== -1) cmdHistory.splice(i, 1);
  cmdHistory.unshift(cmd);
}

// 사용자가 입력한 키 스트림을 추적해 현재 입력 줄(s.inputBuf)을 유지한다.
function trackInput(id, data) {
  const s = sessions.get(id);
  if (!s) return;
  if (data === '\r' || data === '\n') {
    const cmd = (s.inputBuf || '').trim();
    if (cmd) recordCommand(cmd);
    s.inputBuf = '';
  } else if (data === '\x7f' || data === '\b') {
    s.inputBuf = (s.inputBuf || '').slice(0, -1);
  } else if (data.charCodeAt(0) < 0x20) {
    // 화살표/Ctrl 조합 등 제어·이스케이프 → 줄 추적 불가하므로 초기화
    s.inputBuf = '';
  } else if ([...data].every((c) => c >= ' ')) {
    s.inputBuf = (s.inputBuf || '') + data; // 일반 문자(붙여넣기 포함)
  } else {
    s.inputBuf = '';
  }
  updateGhost(s);
}

function updateGhost(s) {
  const buf = s.inputBuf || '';
  let sug = '';
  if (buf.length >= 1) {
    const hit = cmdHistory.find((c) => c.length > buf.length && c.startsWith(buf));
    if (hit) sug = hit.slice(buf.length);
  }
  s.ghostText = sug;
  renderGhost(s);
}

function cellDims(term, pane) {
  try {
    const d = term._core._renderService.dimensions.css.cell;
    if (d && d.width) return { w: d.width, h: d.height };
  } catch (_) {}
  const screen = pane.querySelector('.xterm-screen');
  if (screen && term.cols && term.rows) {
    return { w: screen.clientWidth / term.cols, h: screen.clientHeight / term.rows };
  }
  return null;
}

// ghost 텍스트를 커서 위치에 그린다(.term-pane 패딩 6/8 기준)
function renderGhost(s) {
  const g = s.ghostEl;
  if (!g) return;
  if (!s.ghostText) {
    g.style.display = 'none';
    return;
  }
  const dims = cellDims(s.term, s.pane);
  if (!dims) {
    g.style.display = 'none';
    return;
  }
  const cx = s.term.buffer.active.cursorX;
  const cy = s.term.buffer.active.cursorY;
  g.textContent = s.ghostText;
  g.style.fontSize = (s.term.options.fontSize || 15) + 'px';
  g.style.lineHeight = dims.h + 'px';
  g.style.height = dims.h + 'px';
  g.style.left = 8 + cx * dims.w + 'px';
  g.style.top = 6 + cy * dims.h + 'px';
  g.style.display = 'block';
}

// ===== 메인 프로세스 이벤트 구독 (1회) =====
window.termix.onData(({ id, data }) => {
  const s = sessions.get(id);
  if (!s) return;
  s.term.write(data);
  // 비밀번호 자동 입력: 예약된 비밀번호가 있고 password/passphrase 프롬프트가 보이면 전송.
  if (s.pendingPassword && /(password|passphrase)\s*:?\s*$/i.test(data)) {
    const pw = s.pendingPassword;
    s.pendingPassword = null;
    if (s.pwTimer) {
      clearTimeout(s.pwTimer);
      s.pwTimer = null;
    }
    window.termix.write(id, pw + '\r');
  }
  // SSH 연결 종료 감지 → 로컬 프롬프트가 돌아온 뒤 화면을 비운다.
  if (
    s.sshActive &&
    /(Connection to .+ closed|Connection closed by|Shared connection to .+ closed)/i.test(data)
  ) {
    s.sshActive = false;
    setTimeout(() => s.term.clear(), 150);
  }
});
window.termix.onExit(({ id }) => {
  const s = sessions.get(id);
  if (s) {
    s.term.write('\r\n\x1b[90m[세션이 종료되었습니다]\x1b[0m\r\n');
    const lbl = s.tab.querySelector('.label');
    if (lbl && !/종료/.test(lbl.textContent)) lbl.textContent += ' (종료됨)';
  }
});

// ===== 프로젝트 =====
function createProject(opts = {}) {
  const id = `p${++projCounter}`;
  const name = opts.name || `프로젝트 ${projCounter}`;
  const cwd = opts.cwd || null;

  const el = document.createElement('div');
  el.className = 'project';
  el.innerHTML = `
    <div class="row">
      <span class="name" title="더블클릭하여 이름 변경"></span>
      <span class="count">0</span>
      <span class="del" title="프로젝트 삭제">×</span>
    </div>
    <div class="path" title="클릭하여 작업 폴더 지정"></div>`;

  const nameEl = el.querySelector('.name');
  const countEl = el.querySelector('.count');
  const pathEl = el.querySelector('.path');
  const delEl = el.querySelector('.del');
  nameEl.textContent = name;
  pathEl.textContent = shortPath(cwd);

  nameEl.title = '';
  pathEl.title = '';

  // layout: 분할 레이아웃 트리(leaf/split), focused: 포커스된 세션 id
  const proj = { id, name, cwd, sessionIds: [], activeSessionId: null, layout: null, focused: null, el, nameEl, countEl, pathEl };
  projects.set(id, proj);

  // 일반 클릭 → 프로젝트 선택만
  el.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return; // 좌클릭만
    if (e.target === delEl) return;
    selectProject(id);
  });

  // 우클릭 → 컨텍스트 메뉴 (이름 변경 / 경로 변경 / 삭제)
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    selectProject(id);
    showContextMenu(e.clientX, e.clientY, [
      { label: '이름 변경', action: () => startRename(proj) },
      { label: '경로 변경…', action: () => changeCwd(proj) },
      { sep: true },
      { label: '프로젝트 삭제', danger: true, action: () => deleteProject(id) },
    ]);
  });

  // × 버튼도 그대로 삭제 단축으로 유지
  delEl.addEventListener('click', (e) => {
    e.stopPropagation();
    deleteProject(id);
  });

  projectsEl.appendChild(el);
  return proj;
}

// 프로젝트 작업 폴더 변경
async function changeCwd(proj) {
  const dir = await window.termix.pickFolder();
  if (dir) {
    proj.cwd = dir;
    proj.pathEl.textContent = shortPath(dir);
    persist();
  }
}

function startRename(proj) {
  const el = proj.nameEl;
  el.setAttribute('contenteditable', 'true');
  el.focus();
  // 텍스트 전체 선택
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  const finish = (commit) => {
    el.removeAttribute('contenteditable');
    el.removeEventListener('keydown', onKey);
    el.removeEventListener('blur', onBlur);
    const v = el.textContent.trim();
    if (commit && v && v !== proj.name) {
      proj.name = v;
      persist();
    }
    el.textContent = proj.name;
  };
  const onKey = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    }
  };
  const onBlur = () => finish(true);
  el.addEventListener('keydown', onKey);
  el.addEventListener('blur', onBlur);
}

function deleteProject(pid) {
  const proj = projects.get(pid);
  if (!proj) return;
  // 소속 세션 모두 종료
  [...proj.sessionIds].forEach((sid) => destroySession(sid));
  proj.el.remove();
  projects.delete(pid);
  persist();

  if (activeProjectId === pid) {
    activeProjectId = null;
    const next = [...projects.keys()].pop();
    if (next) selectProject(next);
    else createProject(); // 마지막 프로젝트 삭제 시 새로 하나 생성
  }
}

function selectProject(pid) {
  const proj = projects.get(pid);
  if (!proj) return;
  activeProjectId = pid;

  for (const [id, p] of projects) p.el.classList.toggle('active', id === pid);

  // 프로젝트에 세션이 없으면 하나 만든다.
  if (proj.sessionIds.length === 0) {
    createSession(pid);
    return;
  }
  // 저장된 분할 레이아웃 그대로 복원
  if (!proj.layout) proj.layout = leaf(proj.activeSessionId || proj.sessionIds[0]);
  const leaves = collectLeaves(proj.layout);
  if (!leaves.includes(proj.focused)) proj.focused = leaves[0];
  proj.activeSessionId = proj.focused;
  activeSessionId = proj.focused;
  renderLayout(proj);
  renderTabs();
  const fs = sessions.get(proj.focused);
  if (fs) fs.term.focus();
}

function updateCount(pid) {
  const proj = projects.get(pid);
  if (proj) proj.countEl.textContent = String(proj.sessionIds.length);
}

// ===== 분할 레이아웃 엔진 =====
// 보이지 않는(분할에 없는) pane 을 보관하는 숨김 영역
const paneStore = document.createElement('div');
paneStore.id = 'pane-store';
document.body.appendChild(paneStore);

// 드래그 중 드롭 위치를 표시하는 오버레이
const dropOverlay = document.createElement('div');
dropOverlay.className = 'drop-overlay';
panesEl.appendChild(dropOverlay);

let draggedSid = null;

const leaf = (sid) => ({ type: 'leaf', sid });

function collectLeaves(node, out = []) {
  if (!node) return out;
  if (node.type === 'leaf') out.push(node.sid);
  else node.children.forEach((c) => collectLeaves(c, out));
  return out;
}

function replaceLeafNode(node, sid, replacement) {
  if (node.type === 'leaf') return node.sid === sid ? replacement : node;
  node.children = node.children.map((c) => replaceLeafNode(c, sid, replacement));
  return node;
}

// 해당 sid leaf 를 제거하고 부모 split 을 형제로 접는다.
function removeLeafNode(node, sid) {
  if (node.type === 'leaf') return node.sid === sid ? null : node;
  const kids = node.children.map((c) => removeLeafNode(c, sid)).filter(Boolean);
  if (kids.length === 1) return kids[0]; // 형제만 남으면 split 해제
  node.children = kids;
  return node;
}

// targetSid 패널을 edge 방향으로 분할하고 새 패널에 draggedSid 를 넣는다.
function splitLayout(proj, targetSid, dragSid, edge) {
  if (dragSid === targetSid) return;
  // 드래그한 세션이 이미 레이아웃에 있으면 먼저 제거(이동)
  if (collectLeaves(proj.layout).includes(dragSid)) {
    proj.layout = removeLeafNode(proj.layout, dragSid);
  }
  const dir = edge === 'left' || edge === 'right' ? 'row' : 'col';
  const first = edge === 'left' || edge === 'top';
  const split = {
    type: 'split',
    dir,
    sizes: [1, 1],
    children: first ? [leaf(dragSid), leaf(targetSid)] : [leaf(targetSid), leaf(dragSid)],
  };
  proj.layout = replaceLeafNode(proj.layout, targetSid, split);
  proj.focused = dragSid;
}

// 레이아웃을 DOM 으로 렌더링
function renderLayout(proj) {
  // 모든 세션 pane 을 보관소로 회수
  for (const sid of proj.sessionIds) {
    const s = sessions.get(sid);
    if (s) paneStore.appendChild(s.pane);
  }
  // 기존 레이아웃 DOM 제거(오버레이는 보존)
  [...panesEl.children].forEach((c) => {
    if (c !== dropOverlay) c.remove();
  });
  if (!proj.layout) return;
  panesEl.appendChild(buildNode(proj, proj.layout));
  refitVisible();
}

function buildNode(proj, node) {
  if (node.type === 'leaf') {
    const s = sessions.get(node.sid);
    const multi = collectLeaves(proj.layout).length > 1; // 분할(2개 이상)일 때만 포커스 테두리
    const wrap = document.createElement('div');
    wrap.className = 'leaf' + (multi && node.sid === proj.focused ? ' focused' : '');
    if (s) {
      wrap.appendChild(s.pane);
      wrap.addEventListener('mousedown', () => setFocused(node.sid));
      attachDrop(wrap, proj, node.sid);
    }
    return wrap;
  }
  const el = document.createElement('div');
  el.className = 'split ' + node.dir;
  node.children.forEach((child, i) => {
    const childEl = buildNode(proj, child);
    const grow = (node.sizes && node.sizes[i]) || 1;
    childEl.style.flexGrow = String(grow);
    childEl.style.flexBasis = '0';
    el.appendChild(childEl);
    if (i < node.children.length - 1) {
      el.appendChild(makeResizer(node, el, i));
    }
  });
  return el;
}

function makeResizer(node, splitEl, idx) {
  const r = document.createElement('div');
  r.className = 'resizer';
  r.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const row = node.dir === 'row';
    const childEls = [...splitEl.children].filter((c) => !c.classList.contains('resizer'));
    const a = childEls[idx];
    const b = childEls[idx + 1];
    const rectA = a.getBoundingClientRect();
    const rectB = b.getBoundingClientRect();
    const total = row ? rectA.width + rectB.width : rectA.height + rectB.height;
    const start = row ? e.clientX : e.clientY;
    const growA0 = parseFloat(a.style.flexGrow) || 1;
    const growB0 = parseFloat(b.style.flexGrow) || 1;
    const growSum = growA0 + growB0;
    const move = (ev) => {
      const delta = (row ? ev.clientX : ev.clientY) - start;
      let ratio = (row ? rectA.width : rectA.height) + delta;
      ratio = Math.max(40, Math.min(total - 40, ratio)) / total; // 최소 크기 보장
      const ga = growSum * ratio;
      const gb = growSum - ga;
      a.style.flexGrow = String(ga);
      b.style.flexGrow = String(gb);
      if (node.sizes) {
        node.sizes[idx] = ga;
        node.sizes[idx + 1] = gb;
      }
      refitVisible();
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
  return r;
}

// leaf 에 드롭 핸들러 부착 — 가장자리 4분할 + 중앙(교체)
function attachDrop(wrap, proj, targetSid) {
  wrap.addEventListener('dragover', (e) => {
    if (!draggedSid) return;
    e.preventDefault();
    showDropZone(wrap, dropZone(wrap, e));
  });
  wrap.addEventListener('dragleave', (e) => {
    if (!wrap.contains(e.relatedTarget)) dropOverlay.style.display = 'none';
  });
  wrap.addEventListener('drop', async (e) => {
    if (!draggedSid) return;
    e.preventDefault();
    dropOverlay.style.display = 'none';
    const zone = dropZone(wrap, e);
    let drag = draggedSid;
    draggedSid = null;
    if (zone === 'center') {
      // 중앙: 이 패널을 드래그한 세션으로 교체
      if (drag !== targetSid) {
        if (collectLeaves(proj.layout).includes(drag)) proj.layout = removeLeafNode(proj.layout, drag);
        proj.layout = replaceLeafNode(proj.layout, targetSid, leaf(drag));
        proj.focused = drag;
      }
    } else {
      // 같은 세션을 자기 패널에 떨어뜨리면(=분할할 다른 세션이 없으면) 새 터미널 생성
      if (drag === targetSid) {
        drag = await createSession(proj.id, { attach: false });
      }
      splitLayout(proj, targetSid, drag, zone);
    }
    proj.activeSessionId = proj.focused;
    activeSessionId = proj.focused;
    renderLayout(proj);
    renderTabs();
    const fs = sessions.get(proj.focused);
    if (fs) fs.term.focus();
  });
}

function dropZone(wrap, e) {
  const r = wrap.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width;
  const y = (e.clientY - r.top) / r.height;
  const edge = 0.28;
  if (x < edge) return 'left';
  if (x > 1 - edge) return 'right';
  if (y < edge) return 'top';
  if (y > 1 - edge) return 'bottom';
  return 'center';
}

function showDropZone(wrap, zone) {
  const pr = panesEl.getBoundingClientRect();
  const r = wrap.getBoundingClientRect();
  const o = dropOverlay;
  o.style.display = 'block';
  let left = r.left - pr.left,
    top = r.top - pr.top,
    w = r.width,
    h = r.height;
  if (zone === 'left') w = r.width / 2;
  else if (zone === 'right') {
    left += r.width / 2;
    w = r.width / 2;
  } else if (zone === 'top') h = r.height / 2;
  else if (zone === 'bottom') {
    top += r.height / 2;
    h = r.height / 2;
  }
  o.style.left = left + 'px';
  o.style.top = top + 'px';
  o.style.width = w + 'px';
  o.style.height = h + 'px';
}

// 포커스된 세션 변경(레이아웃 내 패널 클릭 등)
function setFocused(sid) {
  const proj = projects.get(activeProjectId);
  if (!proj) return;
  proj.focused = sid;
  proj.activeSessionId = sid;
  activeSessionId = sid;
  [...panesEl.querySelectorAll('.leaf')].forEach((l) => l.classList.remove('focused'));
  const multi = collectLeaves(proj.layout).length > 1; // 분할일 때만 포커스 테두리
  const s = sessions.get(sid);
  if (s) {
    if (multi && s.pane.parentElement) s.pane.parentElement.classList.add('focused');
    s.tab.classList.remove('attention');
    s.term.focus();
  }
  [...tabsEl.querySelectorAll('.tab')].forEach((t) => t.classList.toggle('active', t === (s && s.tab)));
}

// 현재 보이는(레이아웃에 있는) 모든 터미널을 다시 fit
function refitVisible() {
  requestAnimationFrame(() => {
    const proj = projects.get(activeProjectId);
    if (!proj) return;
    collectLeaves(proj.layout).forEach((sid) => {
      const s = sessions.get(sid);
      if (s && s.pane.clientWidth > 0 && s.pane.clientHeight > 0) {
        try {
          s.fit.fit();
          window.termix.resize(sid, s.term.cols, s.term.rows);
          // pane 을 보관소에서 다시 붙이면 xterm 뷰포트가 맨 위로 리셋된다.
          // fit 직후 맨 아래로 내려 최신 출력(예: claude cli)이 바로 보이게 한다.
          s.term.scrollToBottom();
        } catch (_) {}
      }
    });
  });
}

// ===== 세션 =====
function renderTabs() {
  tabsEl.innerHTML = '';
  const proj = projects.get(activeProjectId);
  if (!proj) return;
  const visible = new Set(collectLeaves(proj.layout));
  proj.sessionIds.forEach((sid) => {
    const s = sessions.get(sid);
    if (!s) return;
    s.tab.classList.toggle('active', sid === proj.focused);
    s.tab.classList.toggle('in-layout', visible.has(sid));
    tabsEl.appendChild(s.tab);
  });
}

async function createSession(pid, { attach = true } = {}) {
  const proj = projects.get(pid);
  if (!proj) return;
  const id = `s${++sessCounter}`;
  const label = `세션 ${sessCounter}`;

  // --- 탭 DOM ---
  const tab = document.createElement('div');
  tab.className = 'tab';
  tab.setAttribute('draggable', 'true');
  tab.innerHTML = `<span class="label">${label}</span><span class="close" title="닫기">×</span>`;
  tab.addEventListener('click', (e) => {
    if (e.target.classList.contains('close')) return;
    setActiveSession(id);
  });
  tab.querySelector('.close').addEventListener('click', (e) => {
    e.stopPropagation();
    closeSession(id);
  });
  // 드래그하여 화면 분할
  tab.addEventListener('dragstart', (e) => {
    draggedSid = id;
    tab.classList.add('dragging');
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  });
  tab.addEventListener('dragend', () => {
    draggedSid = null;
    tab.classList.remove('dragging');
    dropOverlay.style.display = 'none';
  });

  // --- 터미널 pane (처음엔 보관소에 둠; 레이아웃 렌더 시 배치) ---
  const pane = document.createElement('div');
  pane.className = 'term-pane';
  paneStore.appendChild(pane);

  const term = new Terminal({
    fontFamily: '"MesloLGS NF", Menlo, "SF Mono", Monaco, monospace',
    fontSize: 15,
    cursorBlink: true,
    allowProposedApi: true,
    theme: THEME,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon());
  const search = new SearchAddon();
  term.loadAddon(search);
  term.open(pane);

  // 자체 인라인 추천용 ghost 텍스트 레이어
  const ghostEl = document.createElement('div');
  ghostEl.className = 'cmd-ghost';
  ghostEl.style.display = 'none';
  pane.appendChild(ghostEl);

  const safeFit = () => {
    if (pane.clientWidth > 0 && pane.clientHeight > 0) {
      try {
        fit.fit();
      } catch (_) {}
    }
  };
  requestAnimationFrame(safeFit);
  const ro = new ResizeObserver(() => safeFit());
  ro.observe(pane);

  // Shift+Enter 가 눌렸음을 onData 로 전달하는 플래그. 다음 '\r' 한 번을
  // '\x1b\r'(개행)로 바꿔치기하는 데 쓴다.
  let shiftEnterPending = false;

  // Shift+Enter → 개행(ESC+CR). Claude CLI 등에서 줄바꿈 입력에 사용.
  // (Claude 의 /terminal-setup 이 하는 매핑과 동일. 일반 Enter 는 제출 유지)
  //
  // 한글 조합 중에 Shift+Enter 를 우리가 직접 가로채(return false) 처리하면
  // xterm 의 조합 글자 확정 로직(CompositionHelper.keydown)이 건너뛰어져
  // 마지막 글자가 미확정 상태로 새 줄에 같이 내려간다. 그래서 가로채지 않고
  // xterm 이 Enter 를 평소대로 처리(= 조합 글자 확정 + '\r' 전송)하게 둔 뒤,
  // 그 결과로 나온 '\r' 만 onData 단계에서 '\x1b\r'(개행)로 바꿔준다.
  // (Right 화살표를 누르면 줄바꿈이 잘 되던 것과 동일한 확정 경로를 탄다.)
  term.attachCustomKeyEventHandler((e) => {
    if (e.type === 'keydown' && e.key === 'Enter' && e.shiftKey && !e.metaKey && !e.altKey && !e.ctrlKey) {
      shiftEnterPending = true;
      return true; // xterm 정상 처리: 조합 글자 확정 후 '\r' 전송 → onData 에서 변환
    }
    // → (오른쪽 화살표): 추천이 떠 있으면 그것을 수락(나머지를 입력)
    if (
      e.type === 'keydown' &&
      e.key === 'ArrowRight' &&
      !e.metaKey && !e.altKey && !e.ctrlKey && !e.shiftKey
    ) {
      const s = sessions.get(id);
      if (s && s.ghostText) {
        const rem = s.ghostText;
        s.inputBuf = (s.inputBuf || '') + rem;
        window.termix.write(id, rem);
        updateGhost(s);
        e.preventDefault();
        return false;
      }
    }
    return true;
  });

  // 터미널 벨(Claude Code의 terminal_bell 등) → 데스크탑 알림
  term.onBell(() => notifySession(id, '작업 완료 또는 입력 대기'));
  // iTerm 스타일 OSC 9 알림 시퀀스(\x1b]9;메시지\x07) → 데스크탑 알림
  term.parser.registerOscHandler(9, (msg) => {
    notifySession(id, msg || '알림');
    return true;
  });

  // 백엔드 PTY 세션 생성 (프로젝트의 작업 폴더에서)
  await window.termix.createSession({
    id,
    cols: term.cols,
    rows: term.rows,
    cwd: proj.cwd || undefined,
  });

  const dispose = [];
  dispose.push(() => ro.disconnect());
  dispose.push(
    term.onData((data) => {
      // Shift+Enter 로 인한 '\r' 은 개행(ESC+CR)으로 바꾼다. 조합 글자 확정으로
      // 인한 onData 는 '\r' 이 아니므로 그대로 통과하고, 바로 뒤따르는 '\r' 만
      // 변환되어 "글자 → 개행" 순서가 자연히 보장된다.
      if (shiftEnterPending && data === '\r') {
        shiftEnterPending = false;
        data = '\x1b\r';
      } else if (data === '\r') {
        // `claude` 실행 시: 줄 맨 앞에 `clear && ` 를 끼워넣어 실행한다. 그러면
        // 이전 프롬프트/기록이 화면·스크롤백에서 지워지고 claude 가 맨 위부터
        // 그려진다. (Ctrl-A 로 줄 앞 이동 → 'clear && ' 삽입 → Ctrl-E 로 끝.)
        const s = sessions.get(id);
        const cmd = ((s && s.inputBuf) || '').trim();
        if (/^claude(\s|$)/.test(cmd)) {
          trackInput(id, '\r'); // 명령 기록 + inputBuf 리셋
          window.termix.write(id, '\x01clear && \x05\r');
          return;
        }
      }
      trackInput(id, data); // 자체 추천: 입력 줄 추적
      window.termix.write(id, data);
    }).dispose
  );
  dispose.push(term.onResize(({ cols, rows }) => window.termix.resize(id, cols, rows)).dispose);

  sessions.set(id, { id, projectId: pid, term, fit, search, pane, tab, dispose, ghostEl, inputBuf: '', ghostText: '' });
  proj.sessionIds.push(id);
  updateCount(pid);

  // 커서 이동/렌더 시 ghost 위치 갱신(셸 에코 이후 정확히 맞춰짐)
  const sObj = sessions.get(id);
  dispose.push(term.onCursorMove(() => renderGhost(sObj)).dispose);
  dispose.push(term.onRender(() => renderGhost(sObj)).dispose);

  if (attach) {
    renderTabs();
    setActiveSession(id);
  }
  return id;
}

function setActiveSession(sid) {
  const s = sessions.get(sid);
  if (!s) return;
  const proj = projects.get(s.projectId);
  if (!proj) return;

  const leaves = collectLeaves(proj.layout);
  if (!proj.layout) {
    proj.layout = leaf(sid); // 첫 세션 → 단일 패널
  } else if (!leaves.includes(sid)) {
    // 레이아웃에 없는 세션을 띄울 땐 포커스된 패널을 이 세션으로 교체
    const target = leaves.includes(proj.focused) ? proj.focused : leaves[0];
    proj.layout = replaceLeafNode(proj.layout, target, leaf(sid));
  }
  proj.focused = sid;
  proj.activeSessionId = sid;
  activeSessionId = sid;
  s.tab.classList.remove('attention'); // 확인했으므로 미확인 표시 제거

  renderLayout(proj);
  renderTabs();
  s.term.focus();
}

// PTY/리소스만 정리 (프로젝트 목록·후속 활성화 처리는 호출부에서)
function destroySession(sid) {
  const s = sessions.get(sid);
  if (!s) return;
  // 검색 중인 세션이 닫히면 검색바를 닫아 끊긴 애드온 참조를 정리한다.
  if (s.search && s.search === searchSubscribedAddon) closeSearch();
  window.termix.kill(sid);
  s.dispose.forEach((fn) => fn && fn());
  s.term.dispose();
  s.pane.remove();
  s.tab.remove();
  sessions.delete(sid);
  const proj = projects.get(s.projectId);
  if (proj) {
    proj.sessionIds = proj.sessionIds.filter((x) => x !== sid);
    if (proj.activeSessionId === sid) proj.activeSessionId = null;
    updateCount(proj.id);
  }
  return s.projectId;
}

function closeSession(sid) {
  const s = sessions.get(sid);
  if (!s) return;
  const pid = s.projectId;
  const proj = projects.get(pid);
  const wasFocused = proj && proj.focused === sid;
  destroySession(sid);
  if (!proj) return;

  // 레이아웃에서 제거(분할이면 형제 패널이 자리를 채운다)
  if (proj.layout) proj.layout = removeLeafNode(proj.layout, sid);

  if (pid !== activeProjectId) return;

  const leaves = collectLeaves(proj.layout);
  if (leaves.length) {
    if (wasFocused || !leaves.includes(proj.focused)) proj.focused = leaves[leaves.length - 1];
    proj.activeSessionId = proj.focused;
    activeSessionId = proj.focused;
    renderLayout(proj);
    renderTabs();
    const fs = sessions.get(proj.focused);
    if (fs) fs.term.focus();
  } else if (proj.sessionIds.length) {
    setActiveSession(proj.sessionIds[proj.sessionIds.length - 1]); // 숨은 세션 표시
  } else {
    createSession(pid); // 세션이 하나도 없으면 새로 생성
  }
}

// ===== 전역 UI =====
function addProject() {
  const proj = createProject();
  persist();
  selectProject(proj.id);
  startRename(proj); // 생성 직후 이름 입력 모드
}

document.getElementById('new-project').addEventListener('click', addProject);

document.getElementById('new-tab').addEventListener('click', () => {
  if (activeProjectId) createSession(activeProjectId);
});

// ===== 사이드 패널 (Cmd/Ctrl+O) — SSH 접속 / 프롬프트 탭 =====
const sshPanel = document.getElementById('ssh-panel');
const sshList = document.getElementById('ssh-list');
const promptListEl = document.getElementById('prompt-list');

// 접속 항목: { id, name, command, password }
let connections = [];
let connCounter = 0;

// 'ssh' | 'prompt' — 현재 보고 있는 패널 탭
let activePanelTab = 'ssh';

function persistConnections() {
  window.termix.saveConnections(connections);
}

function refitActive() {
  refitVisible();
}

function toggleSsh(force) {
  const show = typeof force === 'boolean' ? force : sshPanel.classList.contains('hidden');
  sshPanel.classList.toggle('hidden', !show);
  refitActive(); // 패널 토글로 터미널 폭이 바뀌므로 다시 맞춘다.
}

// 패널 탭 전환(SSH / 프롬프트)
function selectPanelTab(tab) {
  activePanelTab = tab;
  document.querySelectorAll('.panel-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  sshList.classList.toggle('hidden', tab !== 'ssh');
  promptListEl.classList.toggle('hidden', tab !== 'prompt');
}

document.querySelectorAll('.panel-tab').forEach((b) => {
  b.addEventListener('click', () => selectPanelTab(b.dataset.tab));
});

function renderConnections() {
  sshList.innerHTML = '';
  if (!connections.length) {
    sshList.innerHTML =
      '<div class="ssh-empty">등록된 SSH 접속이 없습니다.<br>위 + 버튼으로 접속을 추가하세요.</div>';
    return;
  }
  connections.forEach((conn) => {
    const el = document.createElement('div');
    el.className = 'ssh-item';
    el.title = `클릭하여 실행: ${conn.command}`;
    const lock = conn.password ? '<span class="lock" title="비밀번호 저장됨">🔒</span>' : '';
    el.innerHTML = `<div class="ssh-name">${escapeHtml(conn.name || conn.command)}${lock}</div>
      <div class="ssh-cmd">${escapeHtml(conn.command)}</div>`;
    el.addEventListener('click', () => runConnection(conn));
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, [
        { label: '편집', action: () => openConnModal(conn) },
        { sep: true },
        { label: '삭제', danger: true, action: () => deleteConnection(conn.id) },
      ]);
    });
    sshList.appendChild(el);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function runConnection(conn) {
  if (!activeSessionId) return;
  const s = sessions.get(activeSessionId);
  if (!s) return;
  // 비밀번호가 있으면, 곧 도착할 password 프롬프트에 자동 입력하도록 예약한다.
  if (conn.password) {
    if (s.pwTimer) clearTimeout(s.pwTimer);
    s.pendingPassword = conn.password;
    s.pwTimer = setTimeout(() => {
      s.pendingPassword = null;
      s.pwTimer = null;
    }, 20000); // 20초 내 프롬프트가 안 오면 취소
  }
  // 접속 시 이전 출력을 지우고 깨끗한 화면에서 시작한다.
  s.term.clear();
  // ssh 명령이면 연결 종료 감지를 위해 플래그를 켠다.
  s.sshActive = /^ssh\b/.test(conn.command.trim());
  window.termix.write(activeSessionId, conn.command + '\r');
  s.term.focus();
}

function deleteConnection(id) {
  connections = connections.filter((c) => c.id !== id);
  persistConnections();
  renderConnections();
}

document.getElementById('ssh-close').addEventListener('click', () => toggleSsh(false));
document.getElementById('ssh-add').addEventListener('click', () => {
  if (activePanelTab === 'prompt') openPromptModal(null);
  else openConnModal(null);
});

// ===== 접속 추가/편집 모달 =====
const modalOverlay = document.getElementById('modal-overlay');
const mTitle = modalOverlay.querySelector('.modal-title');
const mName = document.getElementById('m-name');
const mCmd = document.getElementById('m-cmd');
const mPw = document.getElementById('m-pw');
let editingConn = null;

function openConnModal(conn) {
  editingConn = conn;
  mTitle.textContent = conn ? 'SSH 접속 편집' : 'SSH 접속 추가';
  mName.value = conn ? conn.name || '' : '';
  mCmd.value = conn ? conn.command || '' : '';
  mPw.value = conn ? conn.password || '' : '';
  modalOverlay.classList.remove('hidden');
  setTimeout(() => mName.focus(), 0);
}

function closeConnModal() {
  modalOverlay.classList.add('hidden');
  editingConn = null;
}

function saveConnModal() {
  const name = mName.value.trim();
  const command = mCmd.value.trim();
  const password = mPw.value; // 공백 보존 가능성 있어 trim 안 함
  if (!command) {
    mCmd.focus();
    return;
  }
  if (editingConn) {
    editingConn.name = name || command;
    editingConn.command = command;
    editingConn.password = password;
  } else {
    connections.push({ id: `c${++connCounter}`, name: name || command, command, password });
  }
  persistConnections();
  renderConnections();
  closeConnModal();
}

document.getElementById('m-save').addEventListener('click', saveConnModal);
document.getElementById('m-cancel').addEventListener('click', closeConnModal);
modalOverlay.addEventListener('mousedown', (e) => {
  if (e.target === modalOverlay) closeConnModal();
});
modalOverlay.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    saveConnModal();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeConnModal();
  }
});

// ===== 프롬프트 목록 (사용자 등록) =====
// 프롬프트 항목: { id, name, content, send }
let prompts = [];
let promptCounter = 0;

function persistPrompts() {
  window.termix.savePrompts(prompts);
}

function renderPrompts() {
  promptListEl.innerHTML = '';
  if (!prompts.length) {
    promptListEl.innerHTML =
      '<div class="ssh-empty">저장된 프롬프트가 없습니다.<br>위 + 버튼으로 프롬프트를 추가하세요.</div>';
    return;
  }
  prompts.forEach((p) => {
    const el = document.createElement('div');
    el.className = 'ssh-item prompt-item';
    el.title = '클릭하여 터미널에 입력';
    const send = p.send ? '<span class="lock" title="선택 시 바로 실행">↵</span>' : '';
    const preview = (p.content || '').replace(/\s+/g, ' ').trim();
    el.innerHTML = `<div class="ssh-name">${escapeHtml(p.name || preview)}${send}</div>
      <div class="ssh-cmd">${escapeHtml(preview)}</div>`;
    el.addEventListener('click', () => runPrompt(p));
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, [
        { label: '편집', action: () => openPromptModal(p) },
        { sep: true },
        { label: '삭제', danger: true, action: () => deletePrompt(p.id) },
      ]);
    });
    promptListEl.appendChild(el);
  });
}

// 선택한 프롬프트를 현재 활성 터미널에 입력한다.
function runPrompt(p) {
  if (!activeSessionId) return;
  const s = sessions.get(activeSessionId);
  if (!s) return;
  const text = p.content || '';
  if (!text) return;
  window.termix.write(activeSessionId, p.send ? text + '\r' : text);
  s.term.focus();
}

function deletePrompt(id) {
  prompts = prompts.filter((p) => p.id !== id);
  persistPrompts();
  renderPrompts();
}

// ===== 프롬프트 추가/편집 모달 =====
const promptModalOverlay = document.getElementById('prompt-modal-overlay');
const pName = document.getElementById('p-name');
const pContent = document.getElementById('p-content');
const pSend = document.getElementById('p-send');
let editingPrompt = null;

function openPromptModal(p) {
  editingPrompt = p;
  pName.value = p ? p.name || '' : '';
  pContent.value = p ? p.content || '' : '';
  pSend.checked = p ? !!p.send : false;
  promptModalOverlay.classList.remove('hidden');
  setTimeout(() => pName.focus(), 0);
}

function closePromptModal() {
  promptModalOverlay.classList.add('hidden');
  editingPrompt = null;
}

function savePromptModal() {
  const name = pName.value.trim();
  const content = pContent.value;
  const send = pSend.checked;
  if (!content.trim()) {
    pContent.focus();
    return;
  }
  if (editingPrompt) {
    editingPrompt.name = name || content.trim();
    editingPrompt.content = content;
    editingPrompt.send = send;
  } else {
    prompts.push({ id: `pr${++promptCounter}`, name: name || content.trim(), content, send });
  }
  persistPrompts();
  renderPrompts();
  closePromptModal();
}

document.getElementById('p-save').addEventListener('click', savePromptModal);
document.getElementById('p-cancel').addEventListener('click', closePromptModal);
promptModalOverlay.addEventListener('mousedown', (e) => {
  if (e.target === promptModalOverlay) closePromptModal();
});
promptModalOverlay.addEventListener('keydown', (e) => {
  // 내용은 여러 줄 입력이 필요하므로 Enter 로 저장하지 않는다(Cmd/Ctrl+Enter 로 저장).
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    savePromptModal();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closePromptModal();
  }
});

window.addEventListener('resize', () => refitVisible());

// ===== 터미널 텍스트 검색 (Cmd/Ctrl+F) =====
const searchBar = document.getElementById('search-bar');
const searchInput = document.getElementById('search-input');
const searchCount = document.getElementById('search-count');

// 검색 매치 강조 색상(Catppuccin 팔레트에 맞춤)
const SEARCH_DECORATIONS = {
  matchBackground: '#585b70',
  matchOverviewRuler: '#f9e2af',
  activeMatchBackground: '#f9e2af',
  activeMatchColorOverviewRuler: '#f9e2af',
};

let searchSubscribedAddon = null;
let searchResultsDispose = null;

function currentSearch() {
  const s = sessions.get(activeSessionId);
  return s ? s.search : null;
}

function updateSearchCount(index, count) {
  if (!count || count < 0) {
    searchCount.textContent = searchInput.value ? '결과 없음' : '0/0';
  } else {
    searchCount.textContent = `${index >= 0 ? index + 1 : '-'}/${count}`;
  }
}

// 활성 세션의 검색 애드온 결과 이벤트를 구독(세션이 바뀌면 다시 구독)
function subscribeSearchResults() {
  const search = currentSearch();
  if (search === searchSubscribedAddon) return;
  if (searchResultsDispose) {
    searchResultsDispose();
    searchResultsDispose = null;
  }
  searchSubscribedAddon = search;
  if (!search) return;
  const d = search.onDidChangeResults((e) => {
    updateSearchCount(e ? e.resultIndex : -1, e ? e.resultCount : 0);
  });
  searchResultsDispose = () => d.dispose();
}

function runSearch(forward, incremental) {
  subscribeSearchResults();
  const search = currentSearch();
  if (!search) return;
  const term = searchInput.value;
  if (!term) {
    search.clearDecorations();
    updateSearchCount(-1, 0);
    return;
  }
  const opts = { decorations: SEARCH_DECORATIONS, incremental: !!incremental };
  if (forward) search.findNext(term, opts);
  else search.findPrevious(term, opts);
}

function openSearch() {
  if (!activeSessionId) return;
  searchBar.classList.remove('hidden');
  // 터미널에 선택된 한 줄짜리 텍스트가 있으면 검색어로 미리 채운다.
  const s = sessions.get(activeSessionId);
  const sel = s ? s.term.getSelection() : '';
  if (sel && !sel.includes('\n')) searchInput.value = sel;
  searchInput.focus();
  searchInput.select();
  runSearch(true, true);
}

function closeSearch() {
  searchBar.classList.add('hidden');
  const search = currentSearch();
  if (search) search.clearDecorations();
  if (searchResultsDispose) {
    searchResultsDispose();
    searchResultsDispose = null;
  }
  searchSubscribedAddon = null;
  const s = sessions.get(activeSessionId);
  if (s) s.term.focus();
}

searchInput.addEventListener('input', () => runSearch(true, true));
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    runSearch(!e.shiftKey, false);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeSearch();
  } else if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
    e.preventDefault();
    searchInput.select(); // 이미 열려 있으면 검색어 전체 선택
  }
  e.stopPropagation(); // 입력 중 전역 단축키(Cmd+W 등)로 전파 방지
});
document.getElementById('search-next').addEventListener('click', () => {
  runSearch(true, false);
  searchInput.focus();
});
document.getElementById('search-prev').addEventListener('click', () => {
  runSearch(false, false);
  searchInput.focus();
});
document.getElementById('search-close').addEventListener('click', () => closeSearch());

window.addEventListener('keydown', (e) => {
  // 모달 입력 중에는 단축키 무시
  if (!modalOverlay.classList.contains('hidden')) return;
  if (!promptModalOverlay.classList.contains('hidden')) return;
  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return;
  if (e.key === 'o') {
    e.preventDefault();
    toggleSsh();
  } else if (e.key === 'f') {
    e.preventDefault();
    openSearch();
  } else if (e.key === 'n') {
    e.preventDefault();
    addProject();
  } else if (e.key === 't') {
    e.preventDefault();
    if (activeProjectId) createSession(activeProjectId);
  } else if (e.key === 'w') {
    e.preventDefault();
    if (activeSessionId) closeSession(activeSessionId);
  } else if (/^[1-9]$/.test(e.key)) {
    e.preventDefault();
    const proj = projects.get(activeProjectId);
    if (proj) {
      const target = proj.sessionIds[parseInt(e.key, 10) - 1];
      if (target) setActiveSession(target);
    }
  }
});

// ===== 업데이트 알림 (GitHub Releases 최신 버전 확인) =====
// "v0.2.0" vs "0.1.0" 형태를 비교. a 가 더 크면 1.
function compareVersion(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

function showUpdateBanner(tag, url) {
  const banner = document.getElementById('update-banner');
  document.getElementById('update-text').textContent = `새 버전 ${tag} 이(가) 있습니다`;
  const dl = document.getElementById('update-download');
  dl.onclick = () => {
    window.termix.openExternal(url);
    banner.classList.add('hidden');
  };
  document.getElementById('update-dismiss').onclick = () => banner.classList.add('hidden');
  banner.classList.remove('hidden');
}

async function checkForUpdate() {
  try {
    const r = await window.termix.checkUpdate();
    if (!r || !r.latest || !r.latest.tag) return;
    if (compareVersion(r.latest.tag, r.current) > 0) {
      showUpdateBanner(r.latest.tag, r.latest.url || `https://github.com/choral7451/termix/releases/latest`);
    }
  } catch (_) {}
}

// ===== 시작 =====
(async function init() {
  // 저장된 SSH 접속 목록 복원
  try {
    const conns = await window.termix.loadConnections();
    if (Array.isArray(conns)) {
      connections = conns;
      connections.forEach((c) => {
        const n = parseInt(String(c.id).replace(/^c/, ''), 10);
        if (!isNaN(n) && n > connCounter) connCounter = n;
      });
    }
  } catch (_) {}
  renderConnections();

  // 저장된 프롬프트 목록 복원
  try {
    const ps = await window.termix.loadPrompts();
    if (Array.isArray(ps)) {
      prompts = ps;
      prompts.forEach((p) => {
        const n = parseInt(String(p.id).replace(/^pr/, ''), 10);
        if (!isNaN(n) && n > promptCounter) promptCounter = n;
      });
    }
  } catch (_) {}
  renderPrompts();

  // 자체 인라인 추천용 명령어 히스토리 시드(셸 히스토리)
  try {
    const h = await window.termix.loadHistory();
    if (Array.isArray(h)) cmdHistory = h;
  } catch (_) {}

  let saved = [];
  try {
    saved = await window.termix.loadProjects();
  } catch (_) {}

  if (Array.isArray(saved) && saved.length) {
    // 저장된 프로젝트(이름·경로) 복원. 세션은 선택 시 해당 경로에서 새로 생성된다.
    let first = null;
    saved.forEach((p) => {
      const proj = createProject({ name: p.name, cwd: p.cwd });
      if (!first) first = proj;
    });
    selectProject(first.id);
  } else {
    const proj = createProject({ name: '프로젝트 1' });
    persist();
    selectProject(proj.id);
  }

  // 시작 후 백그라운드로 새 버전 확인(실패해도 조용히 무시)
  checkForUpdate();
})();
