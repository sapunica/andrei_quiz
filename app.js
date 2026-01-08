import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getDatabase, ref, get, set, query, orderByChild, equalTo, runTransaction
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js";
import {
  getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";

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
const auth = getAuth(app);

const path = location.pathname;
const isAdminPage = path.endsWith("/admin.html") || path.endsWith("admin.html");

function nowIso() {
  return new Date().toISOString();
}
function formatDuration(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[c]));
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
    if (!qLine || !corrLine || !a || !b2 || !c || !d) throw new Error("Ungültiges Format in einem Fragenblock.");

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

async function isAdmin(uid) {
  const snap = await get(ref(db, `admins/${uid}`));
  return snap.exists() && snap.val() === true;
}

async function ensureKidState(uid) {
  const kidRef = ref(db, `kids/${uid}`);
  const snap = await get(kidRef);
  if (!snap.exists()) {
    await set(kidRef, { points: 0, hours: 0, createdAt: nowIso() });
  }
}

async function awardPoints(uid, gained) {
  const kidRef = ref(db, `kids/${uid}`);
  await runTransaction(kidRef, (cur) => {
    const points = Number(cur?.points ?? 0);
    const hours = Number(cur?.hours ?? 0);

    const total = points + gained;
    const addHours = Math.floor(total / 90);
    const rema
