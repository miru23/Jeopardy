/* =============================================
   JEOPARDY! — game.js
   ============================================= */

/* ===== Constants ===== */
const POINT_VALUES = [100, 200, 300, 400, 500];
const MIN_TEAMS = 2;
const MAX_TEAMS = 5;

/* ===== Global Game State ===== */
const G = {
  teams:      [],  // [{ name: string, score: number }]
  categories: [],  // [string] — 5 or 6 items, ordered by first appearance in sheet
  cells:      {},  // key: "${catIdx}_${points}" → { question, used, el }
  activeCell: null,          // currently-open cell key, or null
  activeTeamIdx: -1,         // index of team whose turn it is to pick (-1 = none selected)
  dailyDoubleWager: 0,       // wager amount for active Daily Double
  timerInterval: null,       // setInterval handle for countdown
  timerSeconds: 15,          // current countdown value
  timerMax: 15,              // max seconds for the current timer (for bar %)
};

/* ===================================================
   SETUP SCREEN
   =================================================== */

let teamCount = 2;
renderTeamInputs();

document.getElementById('btn-add-team').addEventListener('click', () => {
  if (teamCount >= MAX_TEAMS) return;
  teamCount++;
  renderTeamInputs();
  checkStartReady();
});

document.getElementById('btn-remove-team').addEventListener('click', () => {
  if (teamCount <= MIN_TEAMS) return;
  teamCount--;
  renderTeamInputs();
  checkStartReady();
});

document.getElementById('question-file').addEventListener('change', function () {
  if (this.files[0]) processFile(this.files[0]);
});

// Drag-and-drop on the file label
(function () {
  const dropZone = document.querySelector('.file-label');

  dropZone.addEventListener('dragenter', e => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });

  dropZone.addEventListener('dragover', e => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });

  dropZone.addEventListener('dragleave', e => {
    // Only remove if leaving the drop zone entirely (not entering a child)
    if (!dropZone.contains(e.relatedTarget)) {
      dropZone.classList.remove('drag-over');
    }
  });

  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) processFile(file);
  });
}());

function processFile(file) {
  if (!/\.(xlsx|xls|csv)$/i.test(file.name)) {
    showFileStatus('Please drop an XLSX or CSV file.', 'error');
    return;
  }

  document.getElementById('file-label-text').textContent = file.name;
  showFileStatus('Reading file…', '');

  const reader = new FileReader();

  reader.onload = function (e) {
    try {
      let workbook;
      const isCSV = /\.csv$/i.test(file.name);
      if (isCSV) {
        workbook = XLSX.read(e.target.result, { type: 'string' });
      } else {
        workbook = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
      }

      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

      const { categories, cells } = parseQuestions(rows);
      G.categories = categories;
      G.cells = cells;

      const count = Object.keys(cells).length;
      showFileStatus('✓ Loaded ' + count + ' questions across ' + categories.length + ' categories.', 'success');
      checkStartReady();

    } catch (err) {
      G.categories = [];
      G.cells = {};
      showFileStatus(err.message, 'error');
      checkStartReady();
    }
  };

  reader.onerror = function () {
    showFileStatus('Could not read the file. Please try again.', 'error');
  };

  if (/\.csv$/i.test(file.name)) {
    reader.readAsText(file);
  } else {
    reader.readAsArrayBuffer(file);
  }
}

document.getElementById('btn-start').addEventListener('click', startGame);

/* ===================================================
   BOARD SCREEN
   =================================================== */

document.getElementById('btn-end-game').addEventListener('click', () => {
  if (confirm('End the game now and show final scores?')) {
    showEndGame();
  }
});

// Click a team in the scoreboard to make it their turn; click again to deselect
document.getElementById('scoreboard').addEventListener('click', e => {
  const teamEl = e.target.closest('.score-team[data-idx]');
  if (!teamEl || G.activeCell !== null) return;
  const idx = parseInt(teamEl.dataset.idx, 10);
  G.activeTeamIdx = (G.activeTeamIdx === idx) ? -1 : idx;
  renderScoreboard();
  renderTurnStatus();
});

/* ===================================================
   MODAL EVENTS
   =================================================== */

document.getElementById('btn-reveal').addEventListener('click', revealAnswer);
document.getElementById('btn-nobody').addEventListener('click', handleNobody);
document.getElementById('btn-dd-confirm').addEventListener('click', confirmWager);
document.getElementById('btn-start-timer').addEventListener('click', startTimer);

/* ===================================================
   END GAME SCREEN
   =================================================== */

document.getElementById('btn-play-again').addEventListener('click', () => {
  location.reload();
});

/* ===================================================
   SETUP HELPERS
   =================================================== */

function renderTeamInputs() {
  const container = document.getElementById('team-inputs');

  // Preserve values that were already typed
  const existing = Array.from(container.querySelectorAll('.team-input')).map(i => i.value);
  container.innerHTML = '';

  for (let i = 0; i < teamCount; i++) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'team-input';
    input.placeholder = 'Team ' + (i + 1) + ' name';
    input.maxLength = 24;
    if (existing[i] !== undefined) input.value = existing[i];
    input.addEventListener('input', checkStartReady);
    container.appendChild(input);
  }

  document.getElementById('btn-remove-team').disabled = (teamCount <= MIN_TEAMS);
  document.getElementById('btn-add-team').disabled = (teamCount >= MAX_TEAMS);
}

function checkStartReady() {
  const validNames = Array.from(document.querySelectorAll('.team-input'))
    .map(i => i.value.trim())
    .filter(Boolean);
  const catCount = G.categories.length;
  const hasData = ([5, 6].includes(catCount) && Object.keys(G.cells).length === catCount * 5);
  document.getElementById('btn-start').disabled = !(validNames.length >= MIN_TEAMS && hasData);
}

function showFileStatus(msg, type) {
  const el = document.getElementById('file-status');
  el.textContent = msg;
  el.className = type;
}

/* ===================================================
   CSV / XLSX PARSING
   =================================================== */

function parseQuestions(rows) {
  if (!rows || rows.length === 0) {
    throw new Error('The file appears to be empty.');
  }

  // Normalize a header key for fuzzy matching
  const norm = k => String(k).toLowerCase().trim().replace(/[\s_-]+/g, '');

  const rawKeys = Object.keys(rows[0]);
  const keyMap = {};
  rawKeys.forEach(k => { keyMap[norm(k)] = k; });

  // Find the original column name for a list of candidate normalized names
  function col(candidates) {
    for (const c of candidates) {
      if (keyMap[c] !== undefined) return keyMap[c];
    }
    return null;
  }

  const colCat  = col(['category', 'cat']);
  const colPts  = col(['pointvalue', 'points', 'point', 'value', 'dollarvalue', 'dollar']);
  const colClue = col(['question', 'clue', 'q', 'prompt']);
  const colAns  = col(['answer', 'a', 'response', 'correctresponse']);

  if (!colCat)  throw new Error('Missing "Category" column. Check your spreadsheet headers.');
  if (!colPts)  throw new Error('Missing "Point Value" column. Check your spreadsheet headers.');
  if (!colClue) throw new Error('Missing "Question" column. Check your spreadsheet headers.');
  if (!colAns)  throw new Error('Missing "Answer" column. Check your spreadsheet headers.');

  const questions = [];
  const errors = [];

  rows.forEach((row, i) => {
    const cat    = String(row[colCat]  || '').trim();
    const clue   = String(row[colClue] || '').trim();
    const answer = String(row[colAns]  || '').trim();
    const rawPts = String(row[colPts]  || '').replace(/[^0-9]/g, '');
    const pts    = parseInt(rawPts, 10);

    // Skip entirely-blank rows
    if (!cat && !clue && !answer) return;

    if (!cat)    { errors.push('Row ' + (i + 2) + ': missing Category.'); return; }
    if (!clue)   { errors.push('Row ' + (i + 2) + ': missing Question/Clue.'); return; }
    if (!answer) { errors.push('Row ' + (i + 2) + ': missing Answer.'); return; }

    if (!POINT_VALUES.includes(pts)) {
      errors.push('Row ' + (i + 2) + ': invalid point value "' + row[colPts] + '". Must be 100, 200, 300, 400, or 500.');
      return;
    }

    questions.push({ category: cat, points: pts, clue, answer, isDailyDouble: false });
  });

  if (errors.length) {
    throw new Error(errors.slice(0, 5).join('\n'));
  }

  if (questions.length === 0) {
    throw new Error('No valid question rows found in the file.');
  }

  // Derive ordered category list (first-appearance order)
  const categoryOrder = [];
  questions.forEach(q => {
    if (!categoryOrder.includes(q.category)) categoryOrder.push(q.category);
  });

  if (categoryOrder.length < 5 || categoryOrder.length > 6) {
    throw new Error(
      'Expected 5 or 6 categories, found ' + categoryOrder.length + ':\n' +
      categoryOrder.slice(0, 8).join(', ')
    );
  }

  // Validate each category has all 5 point values (exactly once each)
  categoryOrder.forEach(cat => {
    const pts = questions
      .filter(q => q.category === cat)
      .map(q => q.points)
      .sort((a, b) => a - b);

    if (pts.length !== 5 || JSON.stringify(pts) !== JSON.stringify(POINT_VALUES)) {
      throw new Error(
        'Category "' + cat + '" must have exactly one question for each of: ' +
        POINT_VALUES.join(', ') + '.\nFound point values: ' + (pts.length ? pts.join(', ') : 'none')
      );
    }
  });

  // Assign catIndex
  questions.forEach(q => { q.catIndex = categoryOrder.indexOf(q.category); });

  // Randomly assign 2 Daily Doubles (not in $100 row, different categories)
  assignDailyDoubles(questions);

  // Build cells map
  const cells = {};
  questions.forEach(q => {
    const key = q.catIndex + '_' + q.points;
    cells[key] = { question: q, used: false, el: null };
  });

  return { categories: categoryOrder, cells };
}

function assignDailyDoubles(questions) {
  // Eligible: point value >= $200
  const eligible = questions.filter(q => q.points >= 200);

  // Fisher-Yates shuffle
  for (let i = eligible.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = eligible[i]; eligible[i] = eligible[j]; eligible[j] = tmp;
  }

  eligible[0].isDailyDouble = true;

  // Find a second DD in a different category
  const second = eligible.find(q => q.category !== eligible[0].category);
  if (second) second.isDailyDouble = true;
}

/* ===================================================
   START GAME
   =================================================== */

function startGame() {
  G.teams = Array.from(document.querySelectorAll('.team-input'))
    .map(input => ({ name: input.value.trim(), score: 0 }))
    .filter(t => t.name);

  if (G.teams.length < MIN_TEAMS) return;

  G.activeTeamIdx = 0;

  switchScreen('screen-setup', 'screen-board');
  renderBoard();
  renderScoreboard();
  renderTurnStatus();
}

/* ===================================================
   BOARD RENDERING
   =================================================== */

function renderBoard() {
  const grid = document.getElementById('board-grid');
  grid.innerHTML = '';

  // Drive the CSS grid column count from the actual category count
  grid.style.setProperty('--cat-count', G.categories.length);

  // Row 0: category header cells
  G.categories.forEach(cat => {
    const el = document.createElement('div');
    el.className = 'category-header';
    el.textContent = cat;
    grid.appendChild(el);
  });

  // Rows 1–5: one row per point value
  POINT_VALUES.forEach(pts => {
    for (let catIdx = 0; catIdx < G.categories.length; catIdx++) {
      const key = catIdx + '_' + pts;
      const cellState = G.cells[key];
      const el = buildCardCell(key, pts, cellState.question.isDailyDouble);
      cellState.el = el;
      grid.appendChild(el);
    }
  });
}

function buildCardCell(key, points, isDailyDouble) {
  const container = document.createElement('div');
  container.className = 'card-container' + (isDailyDouble ? ' daily-double' : '');

  const card = document.createElement('div');
  card.className = 'card';

  const front = document.createElement('div');
  front.className = 'card-face card-front';
  front.textContent = '$' + points;

  const back = document.createElement('div');
  back.className = 'card-face card-back';

  card.appendChild(front);
  card.appendChild(back);
  container.appendChild(card);

  container.addEventListener('click', () => {
    if (G.cells[key].used || G.activeCell !== null) return;
    if (G.activeTeamIdx < 0) return;  // host must select a team first
    G.activeCell = key;

    // Flip animation → then open modal
    card.classList.add('flipped');
    card.addEventListener('transitionend', () => openModal(key), { once: true });
  });

  return container;
}

/* ===================================================
   SCOREBOARD
   =================================================== */

function renderScoreboard() {
  const board = document.getElementById('scoreboard');
  board.innerHTML = G.teams.map((t, i) => {
    const neg = t.score < 0;
    const display = (neg ? '−' : '') + '$' + Math.abs(t.score).toLocaleString();
    const active = (i === G.activeTeamIdx);
    return (
      '<div class="score-team' + (active ? ' active' : '') + '" data-idx="' + i + '">' +
        (active ? '<span class="turn-badge">▶ PICKING</span>' : '') +
        '<span class="score-name">' + escapeHTML(t.name) + '</span>' +
        '<span class="score-value' + (neg ? ' negative' : '') + '">' + display + '</span>' +
      '</div>'
    );
  }).join('');
}

function renderTurnStatus() {
  const el = document.getElementById('turn-status');
  if (!el) return;
  if (G.activeTeamIdx >= 0) {
    el.textContent = G.teams[G.activeTeamIdx].name + ' — pick a question';
    el.className = 'turn-status has-team';
  } else {
    el.textContent = 'Select a team to pick a question';
    el.className = 'turn-status';
  }
}

/* ===================================================
   MODAL
   =================================================== */

function openModal(key) {
  const q = G.cells[key].question;
  const overlay = document.getElementById('modal-overlay');

  // --- Reset all modal sections ---
  document.getElementById('modal-answer').textContent = '';
  document.getElementById('modal-answer').classList.add('hidden');
  document.getElementById('modal-active-team').innerHTML = '';
  document.getElementById('modal-active-team').classList.add('hidden');
  document.getElementById('modal-active-team').classList.remove('answered-wrong');
  document.getElementById('modal-other-teams').innerHTML = '';
  document.getElementById('modal-other-teams').classList.add('hidden');
  document.getElementById('btn-reveal').classList.add('hidden');
  document.getElementById('btn-nobody').classList.remove('hidden');
  document.getElementById('modal-dd-banner').classList.add('hidden');
  document.getElementById('modal-wager-area').classList.add('hidden');
  document.getElementById('dd-wager-input').value = '';
  document.getElementById('modal-clue').textContent = '';
  resetTimer();
  G.dailyDoubleWager = 0;

  // Header
  document.getElementById('modal-category').textContent = q.category.toUpperCase();
  document.getElementById('modal-points').textContent = '$' + q.points;

  overlay.classList.remove('hidden');

  if (q.isDailyDouble) {
    document.getElementById('modal-dd-banner').classList.remove('hidden');
    document.getElementById('modal-wager-area').classList.remove('hidden');
    document.getElementById('btn-nobody').classList.add('hidden');
    document.getElementById('dd-wager-input').focus();
  } else {
    document.getElementById('modal-clue').textContent = q.clue;
    document.getElementById('btn-reveal').classList.remove('hidden');
    renderActiveTeamPanel(q.points);
  }
}

function confirmWager() {
  const key = G.activeCell;
  const q = G.cells[key].question;

  const rawWager = parseInt(document.getElementById('dd-wager-input').value, 10);
  if (!rawWager || rawWager <= 0) {
    document.getElementById('dd-wager-input').focus();
    return;
  }

  const maxWager = Math.max(...G.teams.map(t => t.score), 500);
  G.dailyDoubleWager = Math.min(rawWager, maxWager);

  document.getElementById('modal-dd-banner').classList.add('hidden');
  document.getElementById('modal-wager-area').classList.add('hidden');
  document.getElementById('modal-clue').textContent = q.clue;
  document.getElementById('modal-points').textContent = '$' + G.dailyDoubleWager + ' (wager)';
  document.getElementById('btn-reveal').classList.remove('hidden');
  document.getElementById('btn-nobody').classList.remove('hidden');

  renderActiveTeamPanel(G.dailyDoubleWager);
}

function revealAnswer() {
  const key = G.activeCell;
  const q = G.cells[key].question;
  document.getElementById('modal-answer').textContent = q.answer;
  document.getElementById('modal-answer').classList.remove('hidden');
  document.getElementById('btn-reveal').classList.add('hidden');
}

function handleNobody() {
  G.activeTeamIdx = (G.activeTeamIdx + 1) % G.teams.length;
  closeModal();
}

// Prominent panel for the team whose turn it was to pick
function renderActiveTeamPanel(pts) {
  const panel = document.getElementById('modal-active-team');
  const team = G.teams[G.activeTeamIdx];
  panel.innerHTML = '';
  panel.classList.remove('hidden');

  const label = document.createElement('div');
  label.className = 'active-team-label';
  label.textContent = team.name;

  const btns = document.createElement('div');
  btns.className = 'active-team-buttons';

  const correctBtn = document.createElement('button');
  correctBtn.className = 'btn-award';
  correctBtn.textContent = '✓ Correct  +$' + pts;
  correctBtn.addEventListener('click', () => {
    G.teams[G.activeTeamIdx].score += pts;
    // winner keeps the pick
    renderScoreboard();
    closeModal();
  });

  const wrongBtn = document.createElement('button');
  wrongBtn.className = 'btn-wrong';
  wrongBtn.textContent = '✗ Wrong  −$' + pts;
  wrongBtn.addEventListener('click', () => {
    G.teams[G.activeTeamIdx].score -= pts;
    renderScoreboard();
    // Dim the active panel and open other teams
    correctBtn.disabled = true;
    wrongBtn.disabled = true;
    panel.classList.add('answered-wrong');
    renderOtherTeamsPanel(pts, G.activeTeamIdx);
  });

  btns.appendChild(correctBtn);
  btns.appendChild(wrongBtn);
  panel.appendChild(label);
  panel.appendChild(btns);
}

// Show team selector buttons so the host picks who answers next.
// Teams that already answered wrong are disabled. If none remain, auto Nobody Got It.
function renderOtherTeamsPanel(pts, excludeIdx, wrongIdxs) {
  wrongIdxs = wrongIdxs || [];

  // Check if any eligible teams remain
  const hasEligible = G.teams.some((_, i) => i !== excludeIdx && !wrongIdxs.includes(i));
  if (!hasEligible) {
    handleNobody();
    return;
  }

  const panel = document.getElementById('modal-other-teams');
  panel.classList.remove('hidden');
  panel.innerHTML = '';

  const heading = document.createElement('div');
  heading.className = 'other-teams-heading';
  heading.textContent = "Who's answering next?";
  panel.appendChild(heading);

  const selector = document.createElement('div');
  selector.className = 'other-teams-selector';

  G.teams.forEach((team, i) => {
    if (i === excludeIdx) return;
    const btn = document.createElement('button');
    btn.className = 'btn-team-select';
    if (wrongIdxs.includes(i)) btn.disabled = true;
    btn.textContent = team.name;
    btn.addEventListener('click', () => {
      showOtherTeamAnswerPhase(pts, excludeIdx, i, wrongIdxs);
    });
    selector.appendChild(btn);
  });

  panel.appendChild(selector);
}

// Show the next team on the clock — auto-start 10s timer, show ✓/✗
function showOtherTeamAnswerPhase(pts, excludeIdx, teamIdx, wrongIdxs) {
  stopTimer();
  const panel = document.getElementById('modal-other-teams');
  panel.classList.remove('hidden');
  panel.innerHTML = '';

  const label = document.createElement('div');
  label.className = 'other-teams-heading';
  label.textContent = 'Answering next:';
  panel.appendChild(label);

  const teamName = document.createElement('div');
  teamName.className = 'active-team-label';
  teamName.textContent = G.teams[teamIdx].name;
  panel.appendChild(teamName);

  const btns = document.createElement('div');
  btns.className = 'active-team-buttons';

  const correctBtn = document.createElement('button');
  correctBtn.className = 'btn-award';
  correctBtn.textContent = '✓ Correct  +$' + pts;
  correctBtn.addEventListener('click', () => {
    G.teams[teamIdx].score += pts;
    G.activeTeamIdx = teamIdx;
    renderScoreboard();
    closeModal();
  });

  const wrongBtn = document.createElement('button');
  wrongBtn.className = 'btn-wrong';
  wrongBtn.textContent = '✗ Wrong  −$' + pts;
  wrongBtn.addEventListener('click', () => {
    G.teams[teamIdx].score -= pts;
    renderScoreboard();
    stopTimer();
    renderOtherTeamsPanel(pts, excludeIdx, wrongIdxs.concat([teamIdx]));
  });

  btns.appendChild(correctBtn);
  btns.appendChild(wrongBtn);
  panel.appendChild(btns);

  // Auto-start 10-second timer for this team
  startTimer(10);
}

function closeModal() {
  const key = G.activeCell;
  stopTimer();
  document.getElementById('modal-overlay').classList.add('hidden');

  G.cells[key].used = true;
  G.cells[key].el.classList.add('used');
  G.activeCell = null;

  renderScoreboard();
  renderTurnStatus();
  checkAllUsed();
}

/* ===================================================
   TIMER
   =================================================== */

function startTimer(duration) {
  duration = duration || 15;
  stopTimer();
  G.timerSeconds = duration;
  G.timerMax = duration;
  document.getElementById('btn-start-timer').classList.add('hidden');
  const display = document.getElementById('timer-display');
  display.classList.remove('hidden');
  display.classList.remove('expired');
  updateTimerDisplay();

  G.timerInterval = setInterval(() => {
    G.timerSeconds--;
    updateTimerDisplay();
    if (G.timerSeconds <= 0) {
      stopTimer();
      document.getElementById('timer-display').classList.add('expired');
    }
  }, 1000);
}

function stopTimer() {
  if (G.timerInterval) {
    clearInterval(G.timerInterval);
    G.timerInterval = null;
  }
}

function resetTimer() {
  stopTimer();
  G.timerSeconds = 15;
  G.timerMax = 15;
  document.getElementById('btn-start-timer').classList.remove('hidden');
  const display = document.getElementById('timer-display');
  display.classList.add('hidden');
  display.classList.remove('expired');
  updateTimerDisplay();
}

function updateTimerDisplay() {
  document.getElementById('timer-count').textContent = G.timerSeconds;
  const pct = (G.timerSeconds / G.timerMax) * 100;
  const fill = document.getElementById('timer-bar-fill');
  fill.style.width = pct + '%';
  const urgent = G.timerSeconds <= 5;
  fill.classList.toggle('urgent', urgent);
  document.getElementById('timer-count').classList.toggle('urgent', urgent);
}

function checkAllUsed() {
  const allUsed = Object.values(G.cells).every(c => c.used);
  if (allUsed) showEndGame();
}

/* ===================================================
   END GAME
   =================================================== */

function showEndGame() {
  switchScreen('screen-board', 'screen-endgame');

  const sorted = [...G.teams].sort((a, b) => b.score - a.score);
  const medals = ['🏆', '🥈', '🥉'];

  const container = document.getElementById('final-scores');
  container.innerHTML = sorted.map((team, rank) => {
    const neg = team.score < 0;
    const display = (neg ? '−' : '') + '$' + Math.abs(team.score).toLocaleString();
    const medal = rank < 3 ? medals[rank] : (rank + 1) + '.';
    return (
      '<div class="final-row' + (rank === 0 ? ' rank-0' : '') + '">' +
        '<span class="final-rank">' + medal + '</span>' +
        '<span class="final-name">' + escapeHTML(team.name) + '</span>' +
        '<span class="final-score' + (neg ? ' negative' : '') + '">' + display + '</span>' +
      '</div>'
    );
  }).join('');

  spawnConfetti();
}

function spawnConfetti() {
  const colors = ['#ffcc00', '#ff6600', '#00ccff', '#ff0066', '#00ff99', '#ff99ff', '#ffffff', '#ff3300'];
  for (let i = 0; i < 120; i++) {
    const piece = document.createElement('span');
    piece.className = 'confetti-piece';
    piece.style.left = (Math.random() * 110 - 5) + 'vw';
    piece.style.background = colors[Math.floor(Math.random() * colors.length)];
    piece.style.width  = (Math.random() * 9 + 5) + 'px';
    piece.style.height = (Math.random() * 12 + 7) + 'px';
    piece.style.borderRadius = Math.random() > 0.5 ? '50%' : '2px';
    piece.style.animationDuration = (Math.random() * 2.5 + 1.8) + 's';
    piece.style.animationDelay    = (Math.random() * 4.5) + 's';
    document.body.appendChild(piece);
    piece.addEventListener('animationend', () => piece.remove());
  }
}

/* ===================================================
   UTILITIES
   =================================================== */

function switchScreen(fromId, toId) {
  document.getElementById(fromId).classList.remove('active');
  document.getElementById(toId).classList.add('active');
}

function escapeHTML(str) {
  return String(str).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
