/* ===== Grade Calculator =====
 * Supports two grading systems per course:
 *  - "weighted": categories with % weights, optional drop-lowest per category
 *  - "points":   flat list of assessments, grade = total earned / total possible
 * Everything is persisted to localStorage.
 */

(function () {
  "use strict";

  const STORAGE_KEY = "gradeCalculatorData";

  // Philippine university grading: 1.00 (excellent) → 3.00 (pass) → 5.00 (fail).
  // Transmutation tables vary per school/prof, so this is fully editable.
  const DEFAULT_SCALE = [
    { letter: "1.00", min: 96 },
    { letter: "1.25", min: 94 },
    { letter: "1.50", min: 92 },
    { letter: "1.75", min: 89 },
    { letter: "2.00", min: 86 },
    { letter: "2.25", min: 83 },
    { letter: "2.50", min: 80 },
    { letter: "2.75", min: 77 },
    { letter: "3.00", min: 75 },
    { letter: "5.00", min: 0 },
  ];

  // ---------- State ----------

  let state = loadState();

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function newCourse(name) {
    return {
      id: uid(),
      name: name || "New Course",
      mode: "weighted", // "weighted" | "points"
      categories: [
        {
          id: uid(),
          name: "Assignments",
          weight: 40,
          drop: 0,
          items: [{ id: uid(), name: "Assignment 1", score: "", total: "" }],
        },
        {
          id: uid(),
          name: "Midterm",
          weight: 25,
          drop: 0,
          items: [{ id: uid(), name: "Midterm Exam", score: "", total: "" }],
        },
        {
          id: uid(),
          name: "Final Exam",
          weight: 35,
          drop: 0,
          items: [{ id: uid(), name: "Final Exam", score: "", total: "" }],
        },
      ],
      pointItems: [{ id: uid(), name: "Assignment 1", score: "", total: "" }],
      scale: DEFAULT_SCALE.map((r) => ({ ...r })),
      target: 90,
      remainingPoints: 100,
    };
  }

  function newSemester(name) {
    const course = newCourse("My Course");
    return {
      id: uid(),
      name: name || "New Semester",
      courses: [course],
      activeCourseId: course.id,
    };
  }

  /**
   * Accepts the current { semesters } format or the older flat { courses }
   * format (pre-semesters saves and exports) and returns a valid state,
   * or null if the data is unusable.
   */
  function normalizeState(parsed) {
    if (!parsed) return null;

    // Old flat format → wrap everything in a single semester.
    if (!parsed.semesters && Array.isArray(parsed.courses) && parsed.courses.length) {
      const sem = {
        id: uid(),
        name: "1st Semester",
        courses: parsed.courses,
        activeCourseId: parsed.activeCourseId,
      };
      parsed = { semesters: [sem], activeSemesterId: sem.id };
    }

    if (!Array.isArray(parsed.semesters) || !parsed.semesters.length) return null;

    for (const sem of parsed.semesters) {
      if (!Array.isArray(sem.courses) || !sem.courses.length) {
        const course = newCourse("My Course");
        sem.courses = [course];
        sem.activeCourseId = course.id;
      }
      // Migrate courses saved with the old letter-grade default scale
      // to the Philippine 1.00–5.00 equivalents.
      for (const course of sem.courses) {
        if (
          Array.isArray(course.scale) &&
          course.scale.some((r) => /^[A-F][+-]?$/.test(String(r.letter)))
        ) {
          course.scale = DEFAULT_SCALE.map((r) => ({ ...r }));
        }
      }
    }
    return parsed;
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const normalized = normalizeState(JSON.parse(raw));
        if (normalized) return normalized;
      }
    } catch (e) {
      console.warn("Could not load saved data:", e);
    }
    const sem = newSemester("1st Semester");
    return { semesters: [sem], activeSemesterId: sem.id };
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      console.warn("Could not save data:", e);
    }
  }

  function activeSemester() {
    return (
      state.semesters.find((s) => s.id === state.activeSemesterId) ||
      state.semesters[0]
    );
  }

  function activeCourse() {
    const sem = activeSemester();
    return sem.courses.find((c) => c.id === sem.activeCourseId) || sem.courses[0];
  }

  // ---------- Calculations ----------

  function num(v) {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }

  /** An item counts as graded when both score and out-of are valid numbers. */
  function gradedItems(items) {
    return items.filter(
      (it) => num(it.score) !== null && num(it.total) !== null && num(it.total) > 0
    );
  }

  /** Percentage for a single item, or null. */
  function itemPct(it) {
    const s = num(it.score);
    const t = num(it.total);
    if (s === null || t === null || t <= 0) return null;
    return (s / t) * 100;
  }

  /**
   * Category result after dropping the lowest `drop` scores (by percentage).
   * Returns { pct, droppedIds } or { pct: null, droppedIds: [] } if nothing graded.
   */
  function categoryResult(cat) {
    let graded = gradedItems(cat.items);
    const droppedIds = [];

    const dropCount = Math.max(0, Math.floor(num(cat.drop) || 0));
    if (dropCount > 0 && graded.length > 1) {
      const sorted = [...graded].sort((a, b) => itemPct(a) - itemPct(b));
      // Never drop everything — keep at least one graded item.
      const toDrop = Math.min(dropCount, graded.length - 1);
      for (let i = 0; i < toDrop; i++) droppedIds.push(sorted[i].id);
      graded = graded.filter((it) => !droppedIds.includes(it.id));
    }

    if (!graded.length) return { pct: null, droppedIds };

    const earned = graded.reduce((sum, it) => sum + num(it.score), 0);
    const possible = graded.reduce((sum, it) => sum + num(it.total), 0);
    return { pct: (earned / possible) * 100, droppedIds };
  }

  /**
   * Overall grade for a weighted course.
   * Grade "so far" is normalized to only the weight that has been graded,
   * which is how most profs report a running grade.
   */
  function weightedResult(course) {
    let gradedWeight = 0;
    let contribution = 0; // sum of weight * pct/100
    let totalWeight = 0;

    for (const cat of course.categories) {
      const w = num(cat.weight);
      if (w === null || w <= 0) continue;
      totalWeight += w;
      const res = categoryResult(cat);
      if (res.pct !== null) {
        gradedWeight += w;
        contribution += (w * res.pct) / 100;
      }
    }

    return {
      pct: gradedWeight > 0 ? (contribution / gradedWeight) * 100 : null,
      contribution, // percentage points already locked in
      gradedWeight,
      totalWeight,
    };
  }

  /** Overall grade for a points-based course. */
  function pointsResult(course) {
    const graded = gradedItems(course.pointItems);
    if (!graded.length) return { pct: null, earned: 0, possible: 0 };
    const earned = graded.reduce((s, it) => s + num(it.score), 0);
    const possible = graded.reduce((s, it) => s + num(it.total), 0);
    return { pct: (earned / possible) * 100, earned, possible };
  }

  function letterFor(pct, scale) {
    if (pct === null) return "—";
    const sorted = [...scale]
      .filter((r) => r.letter && num(r.min) !== null)
      .sort((a, b) => num(b.min) - num(a.min));
    for (const row of sorted) {
      if (pct >= num(row.min)) return row.letter;
    }
    return sorted.length ? sorted[sorted.length - 1].letter : "—";
  }

  function fmt(n, digits = 2) {
    return n === null ? "—" : n.toFixed(digits).replace(/\.?0+$/, "") + "%";
  }

  // ---------- DOM references ----------

  const $ = (sel) => document.querySelector(sel);

  const semesterSelect = $("#semester-select");
  const courseSelect = $("#course-select");
  const categoriesEl = $("#categories");
  const pointsItemsEl = $("#points-items");
  const scaleRowsEl = $("#scale-rows");

  // ---------- Rendering ----------

  function render() {
    renderSemesterSelect();
    renderCourseSelect();
    renderMode();
    renderScale();
    renderResults();
    $("#active-course-label").textContent = activeCourse().name;
    saveState();
  }

  function renderSemesterSelect() {
    semesterSelect.innerHTML = "";
    for (const s of state.semesters) {
      const opt = document.createElement("option");
      opt.value = s.id;
      opt.textContent = s.name;
      if (s.id === activeSemester().id) opt.selected = true;
      semesterSelect.appendChild(opt);
    }
  }

  function renderCourseSelect() {
    courseSelect.innerHTML = "";
    for (const c of activeSemester().courses) {
      const opt = document.createElement("option");
      opt.value = c.id;
      opt.textContent = c.name;
      if (c.id === activeCourse().id) opt.selected = true;
      courseSelect.appendChild(opt);
    }
  }

  function renderMode() {
    const course = activeCourse();
    const weighted = course.mode === "weighted";

    $("#mode-weighted").classList.toggle("active", weighted);
    $("#mode-points").classList.toggle("active", !weighted);
    $("#weighted-section").classList.toggle("hidden", !weighted);
    $("#points-section").classList.toggle("hidden", weighted);
    $("#mode-hint").textContent = weighted
      ? "Each category is worth a % of your final grade (e.g. Quizzes 20%, Final 40%)."
      : "Everything is graded out of points and simply added up (e.g. 850 / 1000 points).";

    if (weighted) renderCategories();
    else renderPointItems();
  }

  function renderCategories() {
    const course = activeCourse();
    categoriesEl.innerHTML = "";

    for (const cat of course.categories) {
      const res = categoryResult(cat);
      const card = document.createElement("div");
      card.className = "category-card";
      card.dataset.catId = cat.id;

      card.innerHTML = `
        <div class="category-head">
          <label class="cat-name">Category
            <input type="text" data-field="cat-name" value="${escapeAttr(cat.name)}" placeholder="e.g. Quizzes" />
          </label>
          <label class="cat-weight">Weight (%)
            <input type="number" data-field="cat-weight" min="0" step="0.5" value="${escapeAttr(cat.weight)}" />
          </label>
          <label class="cat-drop">Drop lowest
            <input type="number" data-field="cat-drop" min="0" step="1" value="${escapeAttr(cat.drop)}" />
          </label>
          <button class="btn-icon" data-action="remove-category" title="Remove category" type="button"><svg class="icon"><use href="#i-x"/></svg></button>
        </div>
        <div class="table-wrap">
          <table class="items-table">
            <thead>
              <tr><th>Name</th><th>Score</th><th>Out of</th><th>%</th><th></th></tr>
            </thead>
            <tbody></tbody>
          </table>
        </div>
        <div class="add-row">
          <button class="btn" data-action="add-item" type="button"><svg class="icon"><use href="#i-plus"/></svg><span>Add item</span></button>
        </div>
        <p class="cat-average">Category average: <strong>${fmt(res.pct)}</strong></p>
      `;

      const tbody = card.querySelector("tbody");
      for (const it of cat.items) {
        tbody.appendChild(itemRow(it, res.droppedIds.includes(it.id)));
      }

      categoriesEl.appendChild(card);
    }

    renderWeightTotal();
  }

  function renderWeightTotal() {
    const course = activeCourse();
    const total = course.categories.reduce(
      (s, c) => s + (num(c.weight) || 0),
      0
    );
    const el = $("#weight-total-hint");
    if (Math.abs(total - 100) < 0.001) {
      el.innerHTML = `<svg class="icon"><use href="#i-check"/></svg><span>Weights add up to 100%.</span>`;
      el.style.color = "var(--success)";
    } else {
      el.innerHTML = `<svg class="icon"><use href="#i-alert"/></svg><span>Weights add up to ${+total.toFixed(2)}% (most syllabi total 100%). The calculator still works — it scales to graded weight.</span>`;
      el.style.color = "var(--warning)";
    }
  }

  function renderPointItems() {
    const course = activeCourse();
    pointsItemsEl.innerHTML = "";
    for (const it of course.pointItems) {
      pointsItemsEl.appendChild(itemRow(it, false));
    }
  }

  function itemRow(it, dropped) {
    const tr = document.createElement("tr");
    tr.dataset.itemId = it.id;
    if (dropped) tr.className = "dropped";
    const pct = itemPct(it);
    tr.innerHTML = `
      <td><input type="text" data-field="item-name" value="${escapeAttr(it.name)}" placeholder="e.g. Quiz 1" /></td>
      <td><input type="number" data-field="item-score" min="0" step="any" value="${escapeAttr(it.score)}" placeholder="—" /></td>
      <td><input type="number" data-field="item-total" min="0" step="any" value="${escapeAttr(it.total)}" placeholder="—" /></td>
      <td class="item-pct">${fmt(pct)}</td>
      <td><button class="btn-icon" data-action="remove-item" title="Remove item" type="button"><svg class="icon"><use href="#i-x"/></svg></button></td>
    `;
    return tr;
  }

  function renderScale() {
    const course = activeCourse();
    scaleRowsEl.innerHTML = "";
    for (let i = 0; i < course.scale.length; i++) {
      const row = course.scale[i];
      const tr = document.createElement("tr");
      tr.dataset.scaleIndex = i;
      tr.innerHTML = `
        <td><input type="text" data-field="scale-letter" value="${escapeAttr(row.letter)}" /></td>
        <td><input type="number" data-field="scale-min" min="0" max="200" step="0.1" value="${escapeAttr(row.min)}" /></td>
        <td><button class="btn-icon" data-action="remove-scale-row" title="Remove row" type="button"><svg class="icon"><use href="#i-x"/></svg></button></td>
      `;
      scaleRowsEl.appendChild(tr);
    }
  }

  function renderResults() {
    const course = activeCourse();
    const weighted = course.mode === "weighted";

    let pct = null;
    let note = "";
    let extraLabel, extraValue;

    if (weighted) {
      const res = weightedResult(course);
      pct = res.pct;
      extraLabel = "Graded Weight";
      extraValue =
        res.gradedWeight > 0
          ? `${+res.gradedWeight.toFixed(2)} / ${+res.totalWeight.toFixed(2)}%`
          : "—";
      if (pct !== null && res.gradedWeight < res.totalWeight) {
        note = `Based on the ${+res.gradedWeight.toFixed(2)}% of the course graded so far. You've locked in ${+res.contribution.toFixed(2)} percentage points toward your final grade.`;
      }
    } else {
      const res = pointsResult(course);
      pct = res.pct;
      extraLabel = "Points";
      extraValue = res.possible > 0 ? `${+res.earned.toFixed(2)} / ${+res.possible.toFixed(2)}` : "—";
    }

    $("#result-percent").textContent = fmt(pct);
    $("#result-letter").textContent = letterFor(pct, course.scale);

    // Grade progress ring (r = 52 → circumference ≈ 326.73)
    const circumference = 2 * Math.PI * 52;
    const frac = pct === null ? 0 : Math.min(100, Math.max(0, pct)) / 100;
    $("#ring-fill").style.strokeDashoffset = String(circumference * (1 - frac));

    $("#result-extra-label").textContent = extraLabel;
    $("#result-extra").textContent = extraValue;
    if (pct === null) {
      note = "No grades yet — enter a score and its “out of” below to see your standing.";
    }
    $("#result-note").textContent = note;

    renderSnapshot();
    renderPredictor();
  }

  /**
   * Semester snapshot: simple average of each graded course's numeric grade
   * equivalent (e.g. 1.75) across the active semester. Falls back to the
   * average percentage when the scales aren't numeric. Not unit-weighted.
   */
  function renderSnapshot() {
    const sem = activeSemester();
    const pcts = [];
    const equivs = [];

    for (const course of sem.courses) {
      const res =
        course.mode === "weighted" ? weightedResult(course) : pointsResult(course);
      if (res.pct === null) continue;
      pcts.push(res.pct);
      const eq = parseFloat(letterFor(res.pct, course.scale));
      if (Number.isFinite(eq)) equivs.push(eq);
    }

    $("#course-count").textContent = String(sem.courses.length);

    const el = $("#gwa-value");
    if (equivs.length) {
      el.textContent = (
        equivs.reduce((a, b) => a + b, 0) / equivs.length
      ).toFixed(2);
    } else if (pcts.length) {
      el.textContent = fmt(pcts.reduce((a, b) => a + b, 0) / pcts.length);
    } else {
      el.textContent = "—";
    }
  }

  function renderPredictor() {
    const course = activeCourse();
    const weighted = course.mode === "weighted";
    const target = num(course.target);
    const resultEl = $("#predictor-result");
    const noteEl = $("#predictor-note");

    const targetInput = $("#target-grade");
    if (targetInput.value !== String(course.target)) targetInput.value = course.target;
    $("#remaining-points-label").classList.toggle("hidden", weighted);
    if (!weighted) {
      const remInput = $("#remaining-points");
      if (remInput.value !== String(course.remainingPoints)) remInput.value = course.remainingPoints;
    }

    resultEl.className = "result-value";

    if (target === null) {
      resultEl.textContent = "—";
      noteEl.textContent = "Enter a target grade.";
      return;
    }

    let needed = null;
    let context = "";

    if (weighted) {
      const res = weightedResult(course);
      const remainingWeight = res.totalWeight - res.gradedWeight;
      if (remainingWeight <= 0) {
        resultEl.textContent = "—";
        noteEl.textContent =
          "Everything is already graded — there's nothing left to earn. Your grade is final.";
        return;
      }
      needed = ((target - res.contribution) / remainingWeight) * 100;
      context = `average across the remaining ${+remainingWeight.toFixed(2)}% of the course (ungraded work)`;
    } else {
      const res = pointsResult(course);
      const remaining = num(course.remainingPoints);
      if (remaining === null || remaining <= 0) {
        resultEl.textContent = "—";
        noteEl.textContent = "Enter how many points are still up for grabs.";
        return;
      }
      const totalPossible = res.possible + remaining;
      const neededPoints = (target / 100) * totalPossible - res.earned;
      needed = (neededPoints / remaining) * 100;
      context = `on the remaining ${+remaining.toFixed(2)} points (${+Math.max(0, neededPoints).toFixed(2)} points)`;
    }

    resultEl.textContent = fmt(Math.max(0, needed));

    if (needed <= 0) {
      resultEl.classList.add("needed-ok");
      noteEl.textContent = `You've already secured ${target}% — anything above 0% ${context} keeps it.`;
    } else if (needed <= 100) {
      resultEl.classList.add(needed > 85 ? "needed-hard" : "needed-ok");
      noteEl.textContent = `You need to average ${fmt(needed)} ${context} to finish with ${target}%.`;
    } else {
      resultEl.classList.add("needed-impossible");
      noteEl.textContent = `You'd need ${fmt(needed)} ${context} — above 100%, so ${target}% isn't reachable without extra credit.`;
    }
  }

  function escapeAttr(v) {
    return String(v ?? "")
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  // ---------- Switch transition: makes changing course/semester evident ----------

  const contentArea = $("#content-area");
  const toastEl = $("#toast");
  const toastTextEl = $("#toast-text");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const SWITCH_MS = 180;

  let toastTimer = null;
  function showToast(message, type = "success") {
    const isError = type === "error";
    toastTextEl.textContent = message;
    toastEl.classList.toggle("toast-error", isError);
    toastEl.querySelector("use").setAttribute("href", isError ? "#i-alert" : "#i-check");
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(
      () => toastEl.classList.remove("show"),
      isError ? 3500 : 2200
    );
  }

  function flashPicker(el) {
    if (!el) return;
    el.classList.add("flash");
    setTimeout(() => el.classList.remove("flash"), 500);
  }

  /**
   * Applies a state change that swaps the active course/semester, fading the
   * course-specific content out and back in around it so the switch reads as
   * a deliberate transition rather than an instant data snap.
   * `toast` may be a string (known upfront) or a function evaluated after
   * applyFn runs (for messages that depend on the resulting state, e.g. which
   * course became active after a delete).
   */
  function switchActive(applyFn, { toast, flashEl } = {}) {
    flashPicker(flashEl);
    const finish = () => {
      applyFn();
      render();
      const message = typeof toast === "function" ? toast() : toast;
      if (message) showToast(message);
    };
    if (reduceMotion) {
      finish();
      return;
    }
    contentArea.classList.add("switching");
    setTimeout(() => {
      finish();
      contentArea.classList.remove("switching");
    }, SWITCH_MS);
  }

  // ---------- In-app dialogs (replace native prompt/confirm) ----------

  const dialogEl = $("#app-dialog");

  function openDialog({ title, message = "", input = null, okText = "OK", danger = false }) {
    return new Promise((resolve) => {
      $("#dialog-title").textContent = title;
      const msgEl = $("#dialog-message");
      msgEl.textContent = message;
      msgEl.classList.toggle("hidden", !message);

      const inputEl = $("#dialog-input");
      const hasInput = input !== null;
      inputEl.classList.toggle("hidden", !hasInput);
      inputEl.value = hasInput ? input : "";

      const okBtn = $("#dialog-ok");
      okBtn.textContent = okText;
      okBtn.className = danger ? "btn btn-destructive" : "btn btn-primary";

      const settle = (value) => {
        dialogEl.close();
        resolve(value);
      };
      const cancelled = () => settle(hasInput ? null : false);

      // Assigned (not addEventListener) so each open overwrites the last.
      okBtn.onclick = () => settle(hasInput ? inputEl.value : true);
      $("#dialog-cancel").onclick = cancelled;
      dialogEl.oncancel = (e) => { e.preventDefault(); cancelled(); };
      dialogEl.onclick = (e) => { if (e.target === dialogEl) cancelled(); };
      inputEl.onkeydown = (e) => {
        if (e.key === "Enter") { e.preventDefault(); okBtn.click(); }
      };

      dialogEl.showModal();
      if (hasInput) { inputEl.focus(); inputEl.select(); }
      else okBtn.focus();
    });
  }

  /** Text prompt; resolves to a trimmed string, or null on cancel/empty. */
  async function promptDialog(title, defaultValue, okText = "OK") {
    const v = await openDialog({ title, input: defaultValue ?? "", okText });
    if (v === null) return null;
    return String(v).trim() || null;
  }

  /** Destructive confirmation; resolves to a boolean. */
  function confirmDialog(title, message, okText = "Delete") {
    return openDialog({ title, message, okText, danger: true });
  }

  // ---------- Event handling ----------

  // Semester selector
  semesterSelect.addEventListener("change", () => {
    const target = semesterSelect.value;
    const sem = state.semesters.find((s) => s.id === target);
    switchActive(() => { state.activeSemesterId = target; }, {
      toast: `Switched to ${sem ? sem.name : "semester"}`,
      flashEl: semesterSelect.closest(".course-select-wrap"),
    });
  });

  $("#btn-add-semester").addEventListener("click", async () => {
    const name = await promptDialog("New semester", "2nd Semester", "Add");
    if (name === null) return;
    const sem = newSemester(name);
    switchActive(() => {
      state.semesters.push(sem);
      state.activeSemesterId = sem.id;
    }, { toast: `Switched to ${sem.name}` });
  });

  $("#btn-rename-semester").addEventListener("click", async () => {
    const sem = activeSemester();
    const name = await promptDialog("Rename semester", sem.name, "Rename");
    if (name === null) return;
    sem.name = name;
    render();
    showToast(`Renamed to ${name}`);
  });

  $("#btn-delete-semester").addEventListener("click", async () => {
    const sem = activeSemester();
    const ok = await confirmDialog(
      `Delete "${sem.name}"?`,
      "All of its courses and grades will be removed. This cannot be undone."
    );
    if (!ok) return;
    switchActive(() => {
      state.semesters = state.semesters.filter((s) => s.id !== sem.id);
      if (!state.semesters.length) state.semesters.push(newSemester("1st Semester"));
      state.activeSemesterId = state.semesters[0].id;
    }, { toast: () => `Switched to ${state.semesters[0].name}` });
  });

  // Course selector
  courseSelect.addEventListener("change", () => {
    const target = courseSelect.value;
    const course = activeSemester().courses.find((c) => c.id === target);
    switchActive(() => { activeSemester().activeCourseId = target; }, {
      toast: `Switched to ${course ? course.name : "course"}`,
      flashEl: courseSelect.closest(".course-select-wrap"),
    });
  });

  $("#btn-add-course").addEventListener("click", async () => {
    const name = await promptDialog("New course", "New Course", "Add");
    if (name === null) return;
    const sem = activeSemester();
    const course = newCourse(name);
    switchActive(() => {
      sem.courses.push(course);
      sem.activeCourseId = course.id;
    }, { toast: `Switched to ${course.name}` });
  });

  $("#btn-rename-course").addEventListener("click", async () => {
    const course = activeCourse();
    const name = await promptDialog("Rename course", course.name, "Rename");
    if (name === null) return;
    course.name = name;
    render();
    showToast(`Renamed to ${name}`);
  });

  $("#btn-delete-course").addEventListener("click", async () => {
    const sem = activeSemester();
    const course = activeCourse();
    const ok = await confirmDialog(
      `Delete "${course.name}"?`,
      "All of its grades will be removed. This cannot be undone."
    );
    if (!ok) return;
    switchActive(() => {
      sem.courses = sem.courses.filter((c) => c.id !== course.id);
      if (!sem.courses.length) sem.courses.push(newCourse("My Course"));
      sem.activeCourseId = sem.courses[0].id;
    }, { toast: () => `Switched to ${sem.courses[0].name}` });
  });

  // Mode toggle
  $("#mode-weighted").addEventListener("click", () => {
    activeCourse().mode = "weighted";
    render();
  });
  $("#mode-points").addEventListener("click", () => {
    activeCourse().mode = "points";
    render();
  });

  // Add category / items
  $("#btn-add-category").addEventListener("click", () => {
    activeCourse().categories.push({
      id: uid(),
      name: "",
      weight: 0,
      drop: 0,
      items: [{ id: uid(), name: "", score: "", total: "" }],
    });
    render();
    categoriesEl.lastElementChild
      ?.querySelector("input[data-field='cat-name']")
      ?.focus();
  });

  $("#btn-add-point-item").addEventListener("click", () => {
    activeCourse().pointItems.push({ id: uid(), name: "", score: "", total: "" });
    render();
    pointsItemsEl.querySelector("tr:last-child input[data-field='item-name']")?.focus();
  });

  // Scale buttons
  $("#btn-add-scale-row").addEventListener("click", () => {
    activeCourse().scale.push({ letter: "", min: "" });
    render();
    $("#scale-details").open = true;
    scaleRowsEl.querySelector("tr:last-child input[data-field='scale-letter']")?.focus();
  });

  $("#btn-reset-scale").addEventListener("click", () => {
    activeCourse().scale = DEFAULT_SCALE.map((r) => ({ ...r }));
    render();
    $("#scale-details").open = true;
  });

  // Predictor inputs
  $("#target-grade").addEventListener("input", (e) => {
    activeCourse().target = e.target.value;
    renderPredictor();
    saveState();
  });

  $("#remaining-points").addEventListener("input", (e) => {
    activeCourse().remainingPoints = e.target.value;
    renderPredictor();
    saveState();
  });

  // Delegated events for dynamic content (categories, items, scale rows)
  document.addEventListener("input", (e) => {
    const field = e.target.dataset.field;
    if (!field) return;

    const course = activeCourse();
    const catCard = e.target.closest("[data-cat-id]");
    const cat = catCard
      ? course.categories.find((c) => c.id === catCard.dataset.catId)
      : null;
    const itemRowEl = e.target.closest("[data-item-id]");
    const scaleRowEl = e.target.closest("[data-scale-index]");

    if (field === "cat-name" && cat) cat.name = e.target.value;
    if (field === "cat-weight" && cat) cat.weight = e.target.value;
    if (field === "cat-drop" && cat) cat.drop = e.target.value;

    if (itemRowEl) {
      const list = cat ? cat.items : course.pointItems;
      const item = list.find((it) => it.id === itemRowEl.dataset.itemId);
      if (item) {
        if (field === "item-name") item.name = e.target.value;
        if (field === "item-score") item.score = e.target.value;
        if (field === "item-total") item.total = e.target.value;
        // Update this row's % in place so typing doesn't lose focus.
        itemRowEl.querySelector(".item-pct").childNodes[0].textContent = fmt(itemPct(item));
      }
    }

    if (scaleRowEl) {
      const row = course.scale[+scaleRowEl.dataset.scaleIndex];
      if (row) {
        if (field === "scale-letter") row.letter = e.target.value;
        if (field === "scale-min") row.min = e.target.value;
      }
    }

    // Live-update summaries without re-rendering inputs (keeps focus).
    if (cat) {
      const res = categoryResult(cat);
      catCard.querySelector(".cat-average strong").textContent = fmt(res.pct);
      catCard.querySelectorAll("tbody tr").forEach((tr) => {
        tr.classList.toggle("dropped", res.droppedIds.includes(tr.dataset.itemId));
      });
      renderWeightTotal();
    }
    renderResults();
    saveState();
  });

  // Structural changes re-render fully (focus loss is fine on click).
  document.addEventListener("click", async (e) => {
    // Clicks can land on the SVG inside a button — resolve to the button.
    const actionEl = e.target.closest("[data-action]");
    if (!actionEl) return;
    const action = actionEl.dataset.action;

    const course = activeCourse();
    const catCard = actionEl.closest("[data-cat-id]");
    const cat = catCard
      ? course.categories.find((c) => c.id === catCard.dataset.catId)
      : null;

    if (action === "remove-category" && cat) {
      if (cat.items.some((it) => it.score !== "" || it.total !== "")) {
        const ok = await confirmDialog(
          `Remove "${cat.name || "Untitled"}"?`,
          "This category and its scores will be removed from the course.",
          "Remove"
        );
        if (!ok) return;
      }
      course.categories = course.categories.filter((c) => c.id !== cat.id);
      render();
    }

    if (action === "add-item" && cat) {
      cat.items.push({ id: uid(), name: "", score: "", total: "" });
      render();
      // Put the cursor in the new row so entry flows without extra clicks.
      categoriesEl
        .querySelector(`[data-cat-id="${cat.id}"] tbody tr:last-child input[data-field="item-name"]`)
        ?.focus();
    }

    if (action === "remove-item") {
      const itemRowEl = e.target.closest("[data-item-id]");
      if (!itemRowEl) return;
      const list = cat ? cat.items : course.pointItems;
      const idx = list.findIndex((it) => it.id === itemRowEl.dataset.itemId);
      if (idx !== -1) list.splice(idx, 1);
      render();
    }

    if (action === "remove-scale-row") {
      const scaleRowEl = e.target.closest("[data-scale-index]");
      if (!scaleRowEl) return;
      course.scale.splice(+scaleRowEl.dataset.scaleIndex, 1);
      render();
      $("#scale-details").open = true;
    }
  });

  // ---------- Import / export / clear ----------

  $("#btn-export").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], {
      type: "application/json",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "grade-calculator-data.json";
    a.click();
    URL.revokeObjectURL(a.href);
    showToast("Data exported");
  });

  $("#import-file").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const normalized = normalizeState(JSON.parse(reader.result));
        if (!normalized) throw new Error("Invalid file format");
        state = normalized;
        if (!state.semesters.some((s) => s.id === state.activeSemesterId)) {
          state.activeSemesterId = state.semesters[0].id;
        }
        render();
        showToast("Data imported");
      } catch (err) {
        showToast("Import failed — that file doesn't look like exported grade data.", "error");
      }
      e.target.value = "";
    };
    reader.readAsText(file);
  });

  $("#btn-clear-all").addEventListener("click", async () => {
    const ok = await confirmDialog(
      "Delete ALL data?",
      "Every semester, course, and grade will be erased. This cannot be undone.",
      "Delete everything"
    );
    if (!ok) return;
    localStorage.removeItem(STORAGE_KEY);
    state = loadState();
    render();
    showToast("All data cleared");
  });

  // ---------- Theme ----------
  // The <head> stamps data-theme before first paint; this just flips it.

  const THEME_KEY = "gradeCalculatorTheme";

  // Keep the browser chrome (mobile address bar) matched to the theme.
  function syncThemeColor() {
    const dark = document.documentElement.dataset.theme === "dark";
    $("#meta-theme-color").setAttribute("content", dark ? "#101219" : "#f6f7fa");
  }

  $("#theme-toggle").addEventListener("click", () => {
    const next =
      document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem(THEME_KEY, next);
    syncThemeColor();
  });

  // Follow the OS setting live, but only until the user explicitly picks one.
  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", (e) => {
      if (!localStorage.getItem(THEME_KEY)) {
        document.documentElement.dataset.theme = e.matches ? "dark" : "light";
        syncThemeColor();
      }
    });

  // ---------- Init ----------

  syncThemeColor();
  render();
})();
