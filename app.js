// app.js (shared by index.html and admin.html)
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getDatabase, ref, get, set, push, update, runTransaction, query, orderByChild, equalTo
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyCbJ7wHDeNfMjnGzwctvhMVqQXSuSSvkzY",
  authDomain: "quiz-andrei.firebaseapp.com",
  databaseURL: "https://quiz-andrei-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "quiz-andrei",
  storageBucket: "quiz-andrei.firebasestorage.app",
  messagingSenderId: "610532400940",
  appId: "1:610532400940:web:d676e3dd0cd5f9d3975689"
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

const isKidPage = location.pathname.endsWith("/") || location.pathname.endsWith("/index.html") || location.pathname.endsWith("index.html");
const isAdminPage = location.pathname.endsWith("admin.html");

const LS_KID = "rq_kidName";
const ADMIN_PIN = "2387"; // change this

function kidKey(name) {
  return name.trim().toLowerCase().replace(/[^a-z0-9äöüß_-]+/gi, "-").slice(0, 40) || "kid";
}

function nowIso() {
  return new Date().toISOString();
}

function formatDuration(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function slug(str) {
  return str.trim().toLowerCase().replace(/[^a-z0-9äöüß]+/gi, "-").replace(/-+/g, "-").replace(/(^-|-$)/g, "") || "quiz";
}

function parseQuizText(text) {
  const blocks = text.split(/\n\s*\n+/).map(b => b.trim()).filter(Boolean);
  const questions = [];

  for (const b of blocks) {
    const lines = b.split("\n").map(x => x.trim()).filter(Boolean);
    const qLine = lines.find(l => l.startsWith("Q:"));
    const corrLine = lines.find(l => l.toLowerCase().startsWith("correct:"));
    const a = lines.find(l => l.startsWith("A)"));
    const b2 = lines.find(l => l.startsWith("B)"));
    const c = lines.find(l => l.startsWith("C)"));
    const d = lines.find(l => l.startsWith("D)"));

    if (!qLine || !corrLine || !a || !b2 || !c || !d) {
      throw new Error("Ungültiges Format in einem Fragenblock.");
    }

    const question = qLine.slice(2).trim();
    const choices = [a.slice(2).trim(), b2.slice(2).trim(), c.slice(2).trim(), d.slice(2).trim()];
    const corr = corrLine.split(":")[1]?.trim()?.toUpperCase();
    const map = { A: 0, B: 1, C: 2, D: 3 };
    if (!(corr in map)) throw new Error("Correct muss A/B/C/D sein.");

    questions.push({ q: question, choices, answerIndex: map[corr] });
  }

  if (questions.length === 0) throw new Error("Keine Fragen gefunden.");
  return questions;
}

async function ensureKidState(kidId) {
  const kidRef = ref(db, `kids/${kidId}`);
  const snap = await get(kidRef);
  if (!snap.exists()) {
    await set(kidRef, { points: 0, hours: 0, createdAt: nowIso() });
  }
}

async function awardPoints(kidId, gainedPoints) {
  const kidRef = ref(db, `kids/${kidId}`);
  return runTransaction(kidRef, (cur) => {
    const points = Number(cur?.points ?? 0);
    const hours = Number(cur?.hours ?? 0);
    const total = points + gainedPoints;

    const addHours = Math.floor(total / 90);
    const remainder = total % 90;

    return {
      ...(cur || {}),
      points: remainder,
      hours: hours + addHours,
      updatedAt: nowIso()
    };
  });
}

async function listPublishedQuizzes() {
  const snap = await get(ref(db, "quizzes"));
  const all = snap.val() || {};
  return Object.entries(all)
    .map(([id, q]) => ({ id, ...q }))
    .filter(q => q.published === true)
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
}

async function loadQuiz(quizId) {
  const snap = await get(ref(db, `quizzes/${quizId}`));
  if (!snap.exists()) throw new Error("Quiz nicht gefunden.");
  return { id: quizId, ...snap.val() };
}

async function hasAttempt(kidId, quizId) {
  const snap = await get(ref(db, `attempts/${kidId}/${quizId}`));
  return snap.exists();
}

async function saveAttempt({ kidId, quiz, score, gainedPoints, durationSec, wrong }) {
  const attemptRef = ref(db, `attempts/${kidId}/${quiz.id}`);
  await set(attemptRef, {
    quizId: quiz.id,
    quizTitle: quiz.title,
    pointsPerQuestion: quiz.pointsPerQuestion,
    questionCount: quiz.questions.length,
    score,
    gainedPoints,
    durationSec,
    wrong, // [{index, q, correct, chosen}]
    completedAt: nowIso()
  });
}

function renderKidPage() {
  const kidNameEl = document.getElementById("kidName");
  const saveKidBtn = document.getElementById("saveKid");
  const pointsPill = document.getElementById("pointsPill");
  const hoursPill = document.getElementById("hoursPill");
  const quizSelect = document.getElementById("quizSelect");
  const startBtn = document.getElementById("startQuiz");
  const quizHint = document.getElementById("quizHint");

  const quizCard = document.getElementById("quizCard");
  const quizTitle = document.getElementById("quizTitle");
  const quizMeta = document.getElementById("quizMeta");
  const timerPill = document.getElementById("timerPill");
  const quizForm = document.getElementById("quizForm");
  const submitBtn = document.getElementById("submitQuiz");
  const submitNote = document.getElementById("submitNote");
  const resultBox = document.getElementById("resultBox");

  let kidName = localStorage.getItem(LS_KID) || "";
  kidNameEl.value = kidName;

  let timer = null;
  let startTs = null;
  let currentQuiz = null;

  async function refreshDashboard() {
    kidName = kidNameEl.value.trim();
    if (!kidName) {
      pointsPill.textContent = "Punkte: –";
      hoursPill.textContent = "Spielzeit: –";
      quizHint.textContent = "Bitte Kid Name speichern.";
      return;
    }
    const kidId = kidKey(kidName);
    await ensureKidState(kidId);
    const snap = await get(ref(db, `kids/${kidId}`));
    const v = snap.val() || { points: 0, hours: 0 };
    pointsPill.textContent = `Punkte: ${v.points} / 90`;
    hoursPill.textContent = `Spielzeit: ${v.hours} h`;
  }

  saveKidBtn.onclick = async () => {
    const v = kidNameEl.value.trim();
    if (!v) return alert("Bitte Namen eingeben.");
    localStorage.setItem(LS_KID, v);
    await refreshDashboard();
    await refreshQuizList();
  };

  async function refreshQuizList() {
    quizSelect.innerHTML = "";
    const name = (localStorage.getItem(LS_KID) || "").trim();
    if (!name) {
      quizHint.textContent = "Bitte Kid Name speichern.";
      return;
    }
    const kidId = kidKey(name);
    const quizzes = await listPublishedQuizzes();

    if (quizzes.length === 0) {
      quizHint.textContent = "Keine veröffentlichten Quizzes.";
      return;
    }

    // show only not yet attempted
    const options = [];
    for (const qz of quizzes) {
      const done = await hasAttempt(kidId, qz.id);
      options.push({ qz, done });
    }

    const available = options.filter(o => !o.done);
    const doneList = options.filter(o => o.done);

    if (available.length === 0) {
      quizHint.textContent = `Alle Quizzes erledigt. (${doneList.length} abgeschlossen)`;
    } else {
      quizHint.textContent = `${available.length} Quiz(zes) verfügbar. (${doneList.length} schon erledigt)`;
    }

    for (const o of available) {
      const opt = document.createElement("option");
      opt.value = o.qz.id;
      opt.textContent = `${o.qz.title} (${o.qz.questionsCount ?? "?"} Fragen)`;
      quizSelect.appendChild(opt);
    }
  }

  function stopTimer() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function startTimer() {
    stopTimer();
    startTs = Date.now();
    timerPill.textContent = "00:00";
    timer = setInterval(() => {
      const sec = Math.floor((Date.now() - startTs) / 1000);
      timerPill.textContent = formatDuration(sec);
    }, 250);
  }

  function renderQuizUI(quiz) {
    quizCard.style.display = "";
    resultBox.style.display = "none";
    resultBox.innerHTML = "";
    submitNote.textContent = "";

    quizTitle.textContent = quiz.title;
    quizMeta.textContent = `Fragen: ${quiz.questions.length} · Punkte pro richtig: ${quiz.pointsPerQuestion}`;

    quizForm.innerHTML = "";
    quiz.questions.forEach((item, idx) => {
      const wrap = document.createElement("div");
      wrap.className = "q";

      const q = document.createElement("div");
      q.className = "big";
      q.textContent = `${idx + 1}) ${item.q}`;
      wrap.appendChild(q);

      const choices = document.createElement("div");
      choices.className = "choices";

      item.choices.forEach((c, ci) => {
        const label = document.createElement("label");
        const input = document.createElement("input");
        input.type = "radio";
        input.name = `q_${idx}`;
        input.value = String(ci);
        label.appendChild(input);
        label.appendChild(document.createTextNode(c));
        choices.appendChild(label);
      });

      wrap.appendChild(choices);
      quizForm.appendChild(wrap);
    });
  }

  startBtn.onclick = async () => {
    const name = (localStorage.getItem(LS_KID) || "").trim();
    if (!name) return alert("Bitte Kid Name speichern.");
    const kidId = kidKey(name);

    const quizId = quizSelect.value;
    if (!quizId) return alert("Kein Quiz ausgewählt.");

    if (await hasAttempt(kidId, quizId)) {
      alert("Dieses Quiz wurde schon gemacht.");
      return refreshQuizList();
    }

    const quiz = await loadQuiz(quizId);
    currentQuiz = quiz;
    renderQuizUI(quiz);
    startTimer();
    window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
  };

  submitBtn.onclick = async () => {
    const name = (localStorage.getItem(LS_KID) || "").trim();
    if (!name) return alert("Bitte Kid Name speichern.");
    const kidId = kidKey(name);

    if (!currentQuiz) return;

    // block if already attempted (double-click / reload)
    if (await hasAttempt(kidId, currentQuiz.id)) {
      stopTimer();
      submitNote.textContent = "Schon erledigt. Keine Punkte.";
      return refreshQuizList();
    }

    // check answered all
    let answered = 0;
    let correct = 0;
    const wrong = [];

    currentQuiz.questions.forEach((item, idx) => {
      const selected = quizForm.querySelector(`input[name="q_${idx}"]:checked`);
      if (selected) answered++;
      const chosen = selected ? Number(selected.value) : null;
      if (chosen === item.answerIndex) {
        correct++;
      } else {
        wrong.push({
          index: idx + 1,
          q: item.q,
          correct: item.choices[item.answerIndex],
          chosen: chosen === null ? null : item.choices[chosen]
        });
      }
    });

    if (answered < currentQuiz.questions.length) {
      resultBox.className = "card warn";
      resultBox.style.display = "";
      resultBox.textContent = `Bitte alle Fragen beantworten. (${answered}/${currentQuiz.questions.length})`;
      return;
    }

    stopTimer();
    const durationSec = Math.floor((Date.now() - startTs) / 1000);
    const gainedPoints = correct * Number(currentQuiz.pointsPerQuestion || 1);

    // write attempt first, then award points (either order is fine; this prevents repeats)
    await saveAttempt({
      kidId,
      quiz: currentQuiz,
      score: correct,
      gainedPoints,
      durationSec,
      wrong
    });

    await awardPoints(kidId, gainedPoints);
    await refreshDashboard();
    await refreshQuizList();

    resultBox.className = "card ok";
    resultBox.style.display = "";
    resultBox.innerHTML = `
      <div class="big">Ergebnis: ${correct}/${currentQuiz.questions.length}</div>
      <div>Punkte: +${gainedPoints}</div>
      <div>Dauer: ${formatDuration(durationSec)}</div>
      <div class="muted" style="margin-top:8px;">Falsche Fragen: ${wrong.length}</div>
    `;
    currentQuiz = null;
  };

  (async () => {
    await refreshDashboard();
    await refreshQuizList();
  })();
}

function renderAdminPage() {
  const pinCard = document.getElementById("pinCard");
  const pinInput = document.getElementById("pinInput");
  const pinBtn = document.getElementById("pinBtn");
  const adminArea = document.getElementById("adminArea");

  const titleInput = document.getElementById("titleInput");
  const ppqInput = document.getElementById("ppqInput");
  const pubSelect = document.getElementById("pubSelect");
  const questionsInput = document.getElementById("questionsInput");
  const createQuizBtn = document.getElementById("createQuiz");
  const createMsg = document.getElementById("createMsg");

  const quizList = document.getElementById("quizList");

  const kidFilter = document.getElementById("kidFilter");
  const loadHistoryBtn = document.getElementById("loadHistory");
  const historyBox = document.getElementById("historyBox");

  function openAdmin() {
    pinCard.style.display = "none";
    adminArea.style.display = "";
    refreshQuizList();
  }

  pinBtn.onclick = () => {
    if (pinInput.value === ADMIN_PIN) openAdmin();
    else alert("Falscher PIN.");
  };

  async function refreshQuizList() {
    const snap = await get(ref(db, "quizzes"));
    const all = snap.val() || {};
    const rows = Object.entries(all)
      .map(([id, q]) => ({ id, ...q }))
      .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

    if (rows.length === 0) {
      quizList.textContent = "Noch keine Quizzes.";
      return;
    }

    const html = [
      "<table>",
      "<thead><tr><th>Titel</th><th>Fragen</th><th>PPQ</th><th>Published</th><th>Erstellt</th></tr></thead>",
      "<tbody>",
      ...rows.map(r => `<tr>
        <td>${escapeHtml(r.title || r.id)}</td>
        <td>${r.questionsCount ?? "?"}</td>
        <td>${r.pointsPerQuestion ?? 1}</td>
        <td>${r.published ? "ja" : "nein"}</td>
        <td>${escapeHtml(r.createdAt || "")}</td>
      </tr>`),
      "</tbody></table>"
    ].join("");
    quizList.innerHTML = html;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
    }[c]));
  }

  createQuizBtn.onclick = async () => {
    createMsg.innerHTML = "";
    const title = titleInput.value.trim();
    const ppq = Number(ppqInput.value);
    const published = pubSelect.value === "true";
    const text = questionsInput.value;

    if (!title) return alert("Bitte Titel eingeben.");
    if (!Number.isFinite(ppq) || ppq < 1) return alert("Punkte pro Frage müssen >= 1 sein.");
    if (!text.trim()) return alert("Bitte Fragen einfügen.");

    let questions;
    try {
      questions = parseQuizText(text);
    } catch (e) {
      createMsg.innerHTML = `<div class="warn">${escapeHtml(e.message || "Formatfehler")}</div>`;
      return;
    }

    const baseId = slug(title);
    const quizId = `${baseId}-${Date.now()}`; // unique even if same title later

    await set(ref(db, `quizzes/${quizId}`), {
      title,
      pointsPerQuestion: ppq,
      published,
      createdAt: nowIso(),
      questionsCount: questions.length,
      questions
    });

    createMsg.innerHTML = `<div class="ok">Gespeichert: ${escapeHtml(title)} (${questions.length} Fragen)</div>`;
    titleInput.value = "";
    questionsInput.value = "";
    await refreshQuizList();
  };

  loadHistoryBtn.onclick = async () => {
    historyBox.textContent = "Lade…";
    const kidName = kidFilter.value.trim();
    if (!kidName) {
      historyBox.textContent = "Bitte Kid Name eingeben (exakt wie im Kid-Page Feld).";
      return;
    }
    const kidId = kidKey(kidName);

    const snap = await get(ref(db, `attempts/${kidId}`));
    const all = snap.val() || {};
    const rows = Object.values(all).sort((a, b) => (b.completedAt || "").localeCompare(a.completedAt || ""));

    if (rows.length === 0) {
      historyBox.textContent = "Keine Attempts gefunden.";
      return;
    }

    const html = [
      "<table>",
      "<thead><tr><th>Quiz</th><th>Datum</th><th>Dauer</th><th>Score</th><th>Falsch</th></tr></thead>",
      "<tbody>",
      ...rows.map(r => {
        const wrong = Array.isArray(r.wrong) ? r.wrong : [];
        const wrongText = wrong.length
          ? wrong.map(w => `${w.index}) ${w.q} (richtig: ${w.correct})`).join("<br>")
          : "–";
        return `<tr>
          <td>${escapeHtml(r.quizTitle || r.quizId)}</td>
          <td>${escapeHtml(r.completedAt || "")}</td>
          <td>${escapeHtml(formatDuration(Number(r.durationSec || 0)))}</td>
          <td>${escapeHtml(`${r.score}/${r.questionCount} (+${r.gainedPoints} Punkte)`)}</td>
          <td>${wrongText}</td>
        </tr>`;
      }),
      "</tbody></table>"
    ].join("");

    historyBox.innerHTML = html;
  };
}

if (isKidPage) renderKidPage();
if (isAdminPage) renderAdminPage();
