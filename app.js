(function () {
  // ---------- Firebase init ----------
  const firebaseConfig = {
    apiKey: "AIzaSyCbJ7wHDeNfMjnGzwctvhMVqQXSuSSvkzY",
    authDomain: "quiz-andrei.firebaseapp.com",
    databaseURL: "https://quiz-andrei-default-rtdb.europe-west1.firebasedatabase.app",
    projectId: "quiz-andrei",
    storageBucket: "quiz-andrei.firebasestorage.app",
    messagingSenderId: "610532400940",
    appId: "1:610532400940:web:d676e3dd0cd5f9d3975689"
  };

  firebase.initializeApp(firebaseConfig);
  const db = firebase.database();
  const auth = firebase.auth();

  const path = location.pathname || "";
  const isAdminPage = path.endsWith("/admin.html") || path.endsWith("admin.html");

  function nowIso() {
    return new Date().toISOString();
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
    }[c]));
  }
  function slug(str) {
    return str.trim().toLowerCase().replace(/[^a-z0-9äöüß]+/gi, "-").replace(/-+/g, "-").replace(/(^-|-$)/g, "") || "quiz";
  }
  function formatDuration(sec) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
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

      const corr = (corrLine.split(":")[1] || "").trim().toUpperCase();
      const map = { A: 0, B: 1, C: 2, D: 3 };
      if (!(corr in map)) throw new Error("Correct muss A/B/C/D sein.");

      questions.push({ q: question, choices, answerIndex: map[corr] });
    }

    if (questions.length === 0) throw new Error("Keine Fragen gefunden.");
    return questions;
  }

  // ---------- Auth UI wiring ----------
  function wireLogin(onReady) {
    const email = document.getElementById("email");
    const password = document.getElementById("password");
    const loginBtn = document.getElementById("loginBtn");
    const logoutBtn = document.getElementById("logoutBtn");
    const loginInfo = document.getElementById("loginInfo");

    if (!loginBtn || !email || !password || !loginInfo) {
      alert("Login UI fehlt (IDs email/password/loginBtn/loginInfo).");
      return;
    }

    loginBtn.addEventListener("click", async () => {
      loginInfo.textContent = "";
      try {
        await auth.signInWithEmailAndPassword(email.value.trim(), password.value);
      } catch (e) {
        loginInfo.textContent = (e && e.message) ? e.message : "Login fehlgeschlagen.";
      }
    });

    if (logoutBtn) {
      logoutBtn.addEventListener("click", async () => {
        await auth.signOut();
      });
    }

    auth.onAuthStateChanged(async (user) => {
      if (!user) {
        loginInfo.textContent = "Bitte einloggen.";
        if (logoutBtn) logoutBtn.style.display = "none";
        return;
      }
      loginInfo.textContent = `Eingeloggt: ${user.email}`;
      if (logoutBtn) logoutBtn.style.display = "";
      await onReady(user);
    });
  }

  // ---------- DB helpers ----------
  async function isAdmin(uid) {
    const snap = await db.ref(`admins/${uid}`).once("value");
    return snap.exists() && snap.val() === true;
  }

  async function ensureKidState(uid) {
    const ref = db.ref(`kids/${uid}`);
    const snap = await ref.once("value");
    if (!snap.exists()) {
      await ref.set({ points: 0, hours: 0, createdAt: nowIso() });
    }
  }

  async function awardPoints(uid, gained) {
    const ref = db.ref(`kids/${uid}`);
    await ref.transaction((cur) => {
      const points = Number(cur && cur.points) || 0;
      const hours = Number(cur && cur.hours) || 0;

      const total = points + gained;
      const addHours = Math.floor(total / 90);
      const remainder = total % 90;

      return Object.assign({}, cur || {}, {
        points: remainder,
        hours: hours + addHours,
        updatedAt: nowIso()
      });
    });
  }

  async function hasAttempt(uid, quizId) {
    const snap = await db.ref(`attempts/${uid}/${quizId}`).once("value");
    return snap.exists();
  }

  async function saveAttempt(uid, quiz, score, gainedPoints, durationSec, wrong) {
    await db.ref(`attempts/${uid}/${quiz.id}`).set({
      quizId: quiz.id,
      quizTitle: quiz.title,
      pointsPerQuestion: quiz.pointsPerQuestion,
      questionCount: quiz.questions.length,
      score,
      gainedPoints,
      durationSec,
      wrong,
      completedAt: nowIso()
    });
  }

  async function listPublishedQuizzesForKid() {
    const snap = await db.ref("quizzes").orderByChild("published").equalTo(true).once("value");
    const all = snap.val() || {};
    return Object.keys(all).map(id => ({ id, ...all[id] }))
      .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  }

  async function listAllQuizzesForAdmin() {
    const snap = await db.ref("quizzes").once("value");
    const all = snap.val() || {};
    return Object.keys(all).map(id => ({ id, ...all[id] }))
      .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  }

  async function loadQuiz(quizId) {
    const snap = await db.ref(`quizzes/${quizId}`).once("value");
    if (!snap.exists()) throw new Error("Quiz nicht gefunden.");
    return { id: quizId, ...snap.val() };
  }

  // ---------- Kid page ----------
  function renderKidPage(user) {
    const kidArea = document.getElementById("kidArea");
    const pickerArea = document.getElementById("pickerArea");

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

    kidArea.style.display = "";
    pickerArea.style.display = "";

    let timer = null;
    let startTs = null;
    let currentQuiz = null;

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

    async function refreshDashboard() {
      await ensureKidState(user.uid);
      const snap = await db.ref(`kids/${user.uid}`).once("value");
      const v = snap.val() || { points: 0, hours: 0 };
      pointsPill.textContent = `Punkte: ${v.points} / 90`;
      hoursPill.textContent = `Spielzeit: ${v.hours} h`;
    }

    async function refreshQuizList() {
      quizSelect.innerHTML = "";
      const quizzes = await listPublishedQuizzesForKid();

      if (quizzes.length === 0) {
        quizHint.textContent = "Keine veröffentlichten Quizzes.";
        return;
      }

      const available = [];
      let doneCount = 0;

      for (const qz of quizzes) {
        const done = await hasAttempt(user.uid, qz.id);
        if (done) doneCount++;
        else available.push(qz);
      }

      if (available.length === 0) {
        quizHint.textContent = `Alle Quizzes erledigt. (${doneCount} abgeschlossen)`;
        return;
      }

      quizHint.textContent = `${available.length} Quiz(zes) verfügbar. (${doneCount} schon erledigt)`;
      for (const qz of available) {
        const opt = document.createElement("option");
        opt.value = qz.id;
        opt.textContent = `${qz.title} (${qz.questionsCount ?? "?"} Fragen)`;
        quizSelect.appendChild(opt);
      }
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
      const quizId = quizSelect.value;
      if (!quizId) return alert("Kein Quiz ausgewählt.");

      if (await hasAttempt(user.uid, quizId)) {
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
  try {
    if (!currentQuiz) return;

    submitBtn.disabled = true;
    submitNote.textContent = "Speichere…";

    if (await hasAttempt(user.uid, currentQuiz.id)) {
      stopTimer();
      submitNote.textContent = "Schon erledigt. Keine Punkte.";
      submitBtn.disabled = false;
      return refreshQuizList();
    }

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
      submitNote.textContent = "";
      submitBtn.disabled = false;
      return;
    }

    stopTimer();

    const durationSec = Math.floor((Date.now() - startTs) / 1000);
    const ppq = Number(currentQuiz.pointsPerQuestion || 1);
    const gainedPoints = correct * ppq;

    await saveAttempt(user.uid, currentQuiz, correct, gainedPoints, durationSec, wrong);
    await awardPoints(user.uid, gainedPoints);

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

    submitNote.textContent = "";
    currentQuiz = null;
    submitBtn.disabled = false;
  } catch (e) {
    stopTimer();
    console.error(e);

    resultBox.className = "card warn";
    resultBox.style.display = "";
    resultBox.textContent =
      "Fehler beim Speichern/Auswerten: " +
      (e && e.message ? e.message : String(e));

    submitNote.textContent = "";
    submitBtn.disabled = false;
  }
};


    (async () => {
      await refreshDashboard();
      await refreshQuizList();
    })();
  }

  // ---------- Admin page ----------
  function renderAdminPage(user) {
    const adminArea = document.getElementById("adminArea");
    const notAdmin = document.getElementById("notAdmin");

    const titleInput = document.getElementById("titleInput");
    const ppqInput = document.getElementById("ppqInput");
    const pubSelect = document.getElementById("pubSelect");
    const questionsInput = document.getElementById("questionsInput");
    const createQuizBtn = document.getElementById("createQuiz");
    const createMsg = document.getElementById("createMsg");

    const quizList = document.getElementById("quizList");
    const loadHistoryBtn = document.getElementById("loadHistory");
    const historyBox = document.getElementById("historyBox");

    async function refreshQuizList() {
      const rows = await listAllQuizzesForAdmin();
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

      const quizId = `${slug(title)}-${Date.now()}`;
      await db.ref(`quizzes/${quizId}`).set({
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
      const snap = await db.ref("attempts").once("value");
      const all = snap.val() || {};

      const flat = [];
      for (const kidUid of Object.keys(all)) {
        const byQuiz = all[kidUid] || {};
        for (const quizId of Object.keys(byQuiz)) {
          flat.push({ kidUid, quizId, ...byQuiz[quizId] });
        }
      }
      flat.sort((a, b) => (b.completedAt || "").localeCompare(a.completedAt || ""));

      if (flat.length === 0) {
        historyBox.textContent = "Keine Attempts gefunden.";
        return;
      }

      const html = [
        "<table>",
        "<thead><tr><th>Kid UID</th><th>Quiz</th><th>Datum</th><th>Dauer</th><th>Score</th><th>Falsch</th></tr></thead>",
        "<tbody>",
        ...flat.map(r => {
          const wrong = Array.isArray(r.wrong) ? r.wrong : [];
          const wrongText = wrong.length
            ? wrong.map(w => `${w.index}) ${escapeHtml(w.q)} (richtig: ${escapeHtml(w.correct)})`).join("<br>")
            : "–";
          return `<tr>
            <td>${escapeHtml(r.kidUid)}</td>
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

    (async () => {
      const ok = await isAdmin(user.uid);
      if (!ok) {
        notAdmin.style.display = "";
        adminArea.style.display = "none";
        return;
      }
      notAdmin.style.display = "none";
      adminArea.style.display = "";
      await refreshQuizList();
    })();
  }

  // ---------- Boot ----------
  wireLogin(async (user) => {
    if (isAdminPage) renderAdminPage(user);
    else renderKidPage(user);
  });
})();
