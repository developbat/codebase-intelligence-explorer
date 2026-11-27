import assert from "node:assert/strict";
import test from "node:test";
import type { IntentAnalysis } from "../../shared/intent";
import type { AiAgentStep } from "../../shared/ai";
import {
  blockDependentsOf,
  intentTask,
  isInspectionAnswer,
  isMicroEditTask,
  shouldRetryWithEditFirst,
  summarizeVerificationSteps,
  taskBudgetForEffort,
  taskBudgetEffort,
  taskStepBudget,
  taskLooksLikeInspection,
  taskLooksLikeVerification,
  taskLooksLikeWrite,
  summaryAllowsNoChanges,
  summaryClaimsAlreadyPresent,
  reviewFileExcerpt,
  summaryReportsBlocker,
  isGeometryEvidenceCheck,
  isSpawnPlacementEvidenceCheck,
  isRemovalEvidenceCheck,
  isRandomStartEvidenceCheck,
  taskLooksLikeSpawnPlacement,
  taskLooksLikeRemoval,
  taskLooksLikeRandomStart,
  needsRenderedGeometryEvidence,
  noChangeCompletionEvidence,
  summaryCitesFileLines,
  taskRequestsVisualShapeOrPlacement,
  splitGoalSections,
  collapseToBuildSession,
  isSmallProjectForBuildSession,
  compactRetryContext,
} from "./ai/loop";
import {
  budgetExceeded,
  impactContext,
  preferredVerificationCommand,
  preferredVerificationCommands,
  readRangeCovered,
  reportsIncompleteWiring,
  reportsRemainingWork,
} from "./ai/service";
import {
  extractNumberedListIntent,
  isContinuationInstruction,
  resolveContinuationGoal,
} from "./ai/intent";
import { summarizeWorkState } from "./ai/workState";

test("a short continuation resolves to the previous substantive request", () => {
  assert.equal(isContinuationInstruction("listeyi yap"), true);
  assert.equal(isContinuationInstruction("devam et"), true);
  assert.equal(isContinuationInstruction("anahtarın rengini değiştir"), false);
  const bigList = [
    "oyunda listedeki güncellemelerin yapılmasını istiyorum:",
    "1. Bölüm sistemi",
    "Tek labirent yerine 5 farklı bölüm oluştur.",
    "2. Savaş sistemi",
    "Space ile ateş edilsin.",
    "3. Envanter",
    "Toplanan nesneler envantere eklensin.",
  ].join("\n");
  const history = [
    { role: "user" as const, content: "önceki bir mesaj" },
    { role: "assistant" as const, content: "tamam" },
    { role: "user" as const, content: bigList },
    { role: "assistant" as const, content: "anladım" },
  ];
  const resolved = resolveContinuationGoal("listeyi yap", history);
  assert.ok(resolved);
  assert.equal(resolved.goal, bigList);
  // The referenced message and later assistant reply are not stacked again.
  assert.equal(resolved.history.length, 2);
  assert.equal(resolved.history[1].content, "tamam");
});

test("a numbered list is extracted deterministically without an intent call", () => {
  const analysis = {
    projectName: "test-maze3",
    files: [
      { path: "game.js", bytes: 9_000 },
      { path: "index.html", bytes: 2_000 },
      { path: "styles.css", bytes: 3_000 },
    ],
    symbols: [],
    tooling: { buildCommands: [], testCommands: [], typecheckCommands: [] },
    languages: { javascript: 1 },
    stats: { files: 3 },
  } as unknown as import("../../shared/types").AnalysisResult;
  const goal = [
    "oyunda listedeki güncellemelerin yapılmasını istiyorum:",
    "1. Bölüm sistemi",
    "Tek labirent yerine 5 farklı bölüm oluştur.",
    "2. Savaş sistemi",
    "Space tuşuyla ateş edilsin.",
    "3. Yeni düşman türleri",
    "Takipçi, Nöbetçi, Hızlı, Tank ve Boss.",
    "4. Envanter ve yetenekler",
    "Toplanan nesneler envantere eklensin.",
  ].join("\n");
  const intent = extractNumberedListIntent(goal, analysis, { language: "tr" });
  assert.ok(intent);
  const behaviors = intent.behaviors ?? [];
  assert.equal(behaviors.length, 4);
  assert.equal(intent.confidence, 0.86);
  assert.equal(intent.needsClarification, false);
  assert.equal(intent.mode, "loop");
  assert.equal(intent.scope, "large");
  assert.ok(behaviors.every((behavior) => behavior.surface === "game"));
  assert.match(intent.normalizedRequest ?? "", /Bölüm sistemi/);
  assert.doesNotMatch(intent.normalizedRequest ?? "", /oyunda listedeki/);
});

test("verified no-change summaries are accepted as completion", () => {
  assert.equal(
    summaryAllowsNoChanges(
      "The full update set is implemented. No further code change was needed; the real entry page passes an end-to-end browser check.",
    ),
    true,
  );
  assert.equal(summaryAllowsNoChanges("The task is incomplete; route wiring is missing."), false);
  assert.equal(
    summaryAllowsNoChanges(
      "respawnReward yedek dalı istenen davranışı zaten uyguluyor; hiçbir dosya değiştirilmedi.",
    ),
    true,
  );
  assert.equal(
    summaryClaimsAlreadyPresent(
      "respawnReward yedek dalı istenen davranışı zaten uyguluyor; hiçbir dosya değiştirilmedi.",
    ),
    true,
  );
});

test("visual shape/placement requests classify and require rendered geometry evidence", () => {
  const task = {
    id: "task-1",
    title: "Random levels, key shape and inventory position",
    detail:
      "bölümler he başlatıldığında random olarak gelsin. anahtar anahtar şeklinde olsun. inventory sol üstre olsun.",
    acceptance: "The key is drawn as a key and the inventory sits in the top-left.",
  } as unknown as Parameters<typeof noChangeCompletionEvidence>[0];
  assert.equal(taskRequestsVisualShapeOrPlacement(task), true);
  assert.equal(taskRequestsVisualShapeOrPlacement({ ...task, title: "Fix the parser crash", detail: "", acceptance: "" }), false);

  const visibilityOnly: AiAgentStep[] = [
    {
      index: 1,
      action: "browser_check",
      ok: true,
      observation: "PASS click #menu-start-btn PASS expectVisible #game PASS expectVisible #inventory",
      args: {
        steps: [
          { action: "click", selector: "#menu-start-btn" },
          { action: "expectVisible", selector: "#inventory" },
        ],
      },
      durationMs: 10,
    },
  ];
  const rejected = noChangeCompletionEvidence(
    task,
    {
      summary: "Already present: key icon at game.js:208 and inventory in the HUD.",
      steps: visibilityOnly,
      changedFiles: [],
    },
    true,
  );
  assert.equal(rejected.ok, false);
  assert.match(rejected.reason, /shape or placement/i);

  const geometryStep: AiAgentStep[] = [
    {
      index: 2,
      action: "browser_check",
      ok: true,
      observation: "PASS eval rect PASS expectText left<120 PASS eval key pixel PASS expectText true",
      args: {
        steps: [
          {
            action: "eval",
            script: "JSON.stringify(document.querySelector('#inventory').getBoundingClientRect())",
          },
          { action: "expectText", selector: "#result", text: "left" },
          {
            action: "eval",
            script:
              "JSON.stringify(document.querySelector('#game').getContext('2d').getImageData(133,63,1,1).data)",
          },
          { action: "expectText", selector: "#result", text: "true" },
        ],
      },
      durationMs: 12,
    },
  ];
  assert.equal(isGeometryEvidenceCheck(geometryStep[0]), true);
  const accepted = noChangeCompletionEvidence(
    task,
    {
      summary:
        "Verified on the real page: key renders as a ring and shaft at game.js:445 and the inventory bounding box is top-left (index.html:48, styles.css:176).",
      steps: geometryStep,
      changedFiles: [],
    },
    true,
  );
  assert.equal(accepted.ok, true);
  assert.equal(needsRenderedGeometryEvidence(task, visibilityOnly, true), true);
  assert.equal(needsRenderedGeometryEvidence(task, geometryStep, true), false);
});

test("a changed file does not excuse unverified 'already present' shape/placement claims", () => {
  const task = {
    id: "task-1",
    title: "bölümler he başlatıldığında random olarak gelsin. anahtar anahtar şeklinde olsun. inven…",
    detail:
      "bölümler he başlatıldığında random olarak gelsin. anahtar anahtar şeklinde olsun. inventory sol üstre olsun.",
    acceptance: "The requested change is implemented and verified on the real page.",
  } as unknown as Parameters<typeof noChangeCompletionEvidence>[0];
  // Real summary and browser_check from test-maze3: game.js changed for the
  // random start, while the key shape and inventory placement were claimed as
  // "already present" from a symbol and a visibility check.
  const summary = `## Outcome
Levels now start at a random level when the game is launched without an explicit level index. The key already renders as a key icon and the inventory already sits in the top-left, so no change was needed there.

## Already present (verified, no edit)
- Key icon: \`ITEM_TYPES.key.icon\` (game.js:208)
- Inventory top-left: \`#inventory\` element is visible in the top-left HUD area (index.html/styles.css).`;
  const steps: AiAgentStep[] = [
    {
      index: 7,
      action: "browser_check",
      ok: true,
      observation:
        "PASS #1 click PASS #2 expectVisible: #game PASS #3 expectText: #level PASS #4 eval PASS #5 expectVisible: #inventory",
      args: {
        steps: [
          { action: "click", selector: "#menu-start-btn" },
          { action: "expectVisible", selector: "#game" },
          { action: "expectText", selector: "#level", text: "1" },
          { action: "eval", script: "document.querySelector('#level').textContent" },
          { action: "expectVisible", selector: "#inventory" },
        ],
      },
      durationMs: 3577,
    },
  ];
  assert.equal(summaryClaimsAlreadyPresent(summary), true);
  const verdict = noChangeCompletionEvidence(
    task,
    { summary, steps, changedFiles: ["game.js"] },
    true,
  );
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /shape or placement/i);
});

test("spawn, removal and random-start tasks require the matching runtime proof", () => {
  const task = {
    id: "task-1",
    title: "Respawn the blue ball and remove the map list",
    detail:
      "mavi küçük top alınabilir maze in hareket edilebilir yerinde respawn olduğundan emin ol. harita listesini kaldır her start dediğimde farklı haritalardan biri random gelsin.",
    acceptance: "The blue ball is reachable and collectible; the level list is gone; starts are random.",
  } as unknown as Parameters<typeof taskLooksLikeSpawnPlacement>[0];
  assert.equal(taskLooksLikeSpawnPlacement(task), true);
  assert.equal(taskLooksLikeRemoval(task), true);
  assert.equal(taskLooksLikeRandomStart(task), true);
  assert.equal(
    taskLooksLikeRemoval({
      ...task,
      title: "Remove unused import",
      detail: "Remove the unused import from parser.ts.",
      acceptance: "",
    }),
    false,
  );

  const weak: AiAgentStep = {
    index: 1,
    action: "browser_check",
    ok: true,
    observation: "PASS click #menu-start-btn PASS expectVisible #game",
    args: {
      steps: [
        { action: "click", selector: "#menu-start-btn" },
        { action: "expectVisible", selector: "#game" },
      ],
    },
    durationMs: 10,
  };
  assert.equal(isSpawnPlacementEvidenceCheck(weak), false);
  assert.equal(isRemovalEvidenceCheck(weak), false);
  assert.equal(isRandomStartEvidenceCheck(weak), false);

  // A level/blue-pixel check is not spawn/reachability evidence.
  const weakSpawn: AiAgentStep = {
    ...weak,
    observation: "PASS eval levels=5/5 PASS eval bluePixels=120 PASS expectText 0",
    args: {
      steps: [
        { action: "eval", script: "document.querySelector('#level').textContent" },
        {
          action: "eval",
          script:
            "const c=document.querySelector('#game');c.getContext('2d').getImageData(0,0,1,1);",
        },
        { action: "expectText", selector: "#score", text: "0" },
      ],
    },
  };
  assert.equal(isSpawnPlacementEvidenceCheck(weakSpawn), false);

  const spawnCheck: AiAgentStep = {
    ...weak,
    observation: "PASS eval rewards PASS expectText true",
    args: {
      steps: [
        {
          action: "eval",
          script:
            "JSON.stringify(LEVELS.map(l => l.rewards.map(r => ({x:r.x,y:r.y,wall:l.map[r.y][r.x]===1}))))",
          expectText: "wall:false",
        },
        { action: "expectText", selector: "#result", text: "wall:false" },
      ],
    },
  };
  assert.equal(isSpawnPlacementEvidenceCheck(spawnCheck), true);

  const removalCheck: AiAgentStep = {
    ...weak,
    observation: "#level-select count is 0 PASS expectCount 0",
    args: {
      steps: [
        { action: "eval", script: "document.querySelectorAll('#level-select').length" },
        { action: "expectCount", selector: "#level-select", count: 0 },
      ],
    },
  };
  assert.equal(isRemovalEvidenceCheck(removalCheck), true);
  const hiddenOnly: AiAgentStep = {
    ...weak,
    observation: "PASS hidden PASS expectText true",
    args: {
      steps: [
        {
          action: "eval",
          script: "document.querySelector('#level-select').hidden",
          expectText: "true",
        },
      ],
    },
  };
  assert.equal(isRemovalEvidenceCheck(hiddenOnly), false);

  const randomCheck: AiAgentStep = {
    ...weak,
    observation: "PASS eval levels PASS expectText 3/5",
    args: {
      steps: [
        {
          action: "eval",
          script:
            "(() => { const out=[]; for(let i=0;i<6;i++){ document.querySelector('#menu-start-btn').click(); out.push(document.querySelector('#level').textContent); } return out; })()",
          expectText: "3/5",
        },
        { action: "expectText", selector: "#result", text: "3/5" },
      ],
    },
  };
  assert.equal(isRandomStartEvidenceCheck(randomCheck), true);
});

test("no-change completion requires file:line evidence and a real check", () => {
  const plain = {
    id: "task-1",
    title: "Tidy the parser",
    detail: "Rename the helper.",
    acceptance: "Tests pass.",
  } as unknown as Parameters<typeof noChangeCompletionEvidence>[0];
  assert.equal(summaryCitesFileLines("game.js:208 has the icon"), true);
  assert.equal(summaryCitesFileLines("game.js has the icon"), false);
  assert.equal(
    noChangeCompletionEvidence(
      plain,
      { summary: "Already present in game.js.", steps: [], changedFiles: [] },
      true,
    ).ok,
    false,
  );
  assert.equal(
    noChangeCompletionEvidence(
      plain,
      {
        summary: "Already present at parser.ts:42; verified with a passing test.",
        steps: [
          {
            index: 1,
            action: "run_test_scenario",
            ok: true,
            observation: "passed",
            args: {},
            durationMs: 5,
          },
        ],
        changedFiles: [],
      },
      false,
    ).ok,
    true,
  );
  assert.equal(
    noChangeCompletionEvidence(
      plain,
      {
        summary: "Already present at parser.ts:42; verified by the required scenario.",
        steps: [],
        changedFiles: [],
      },
      true,
      true,
    ).ok,
    true,
  );
});

test("work state includes the result evidence even when the loop status failed", () => {
  const base = {
    id: "task-1",
    title: "Build the update",
    detail: "",
    status: "failed" as const,
    effort: "standard" as const,
    role: "main" as const,
    dependsOn: [],
    attempts: 2,
    changedFiles: [],
    commands: [],
    createdAt: "",
    updatedAt: "",
    resultSummary:
      "The full update set is implemented. The real entry page passes an end-to-end browser check. No further code change was needed.",
  };
  const queue = {
    version: 1 as const,
    projectId: "p",
    goal: "Build the update",
    status: "failed" as const,
    createdAt: "",
    updatedAt: "",
    notesPath: "",
    planPath: "",
    contextPath: "",
    digestPath: "",
    tasks: [base],
  };
  const state = summarizeWorkState(queue);
  assert.match(state, /Queue status: failed/);
  assert.match(state, /implemented/);
  assert.match(state, /browser check/);
  assert.match(state, /Status is the loop state/);
});

test("retry context carries the failure evidence and changed files", () => {
  const context = compactRetryContext({
    summary: "The replacement snippet was not found.",
    changedFiles: ["styles.css"],
    error: "",
    steps: [
      {
        index: 1,
        action: "replace_in_file",
        args: {},
        observation: "The find snippet was not found in the file.",
        ok: false,
        durationMs: 10,
      },
    ],
  } as unknown as Parameters<typeof compactRetryContext>[0]);
  assert.match(context, /Previous attempt failed/);
  assert.match(context, /styles\.css/);
  assert.match(context, /replace_in_file/);
});

test("small builds collapse plan tasks into one build session with a checklist", () => {
  const analysis = {
    files: [
      { path: "index.html", bytes: 1_500 },
      { path: "styles.css", bytes: 1_200 },
      { path: "game.js", bytes: 2_000 },
      { path: "README.md", bytes: 150 },
    ],
  } as unknown as import("../../shared/types").AnalysisResult;
  assert.equal(isSmallProjectForBuildSession(analysis), true);

  const base = {
    status: "pending" as const,
    effort: "standard" as const,
    role: "main" as const,
    action: "update" as const,
    surface: "ui" as const,
    dependsOn: [],
    attempts: 0,
    changedFiles: [],
    commands: [],
    createdAt: "",
    updatedAt: "",
  };
  const queue = {
    version: 1 as const,
    projectId: "p",
    goal: "Build a game",
    status: "idle" as const,
    createdAt: "",
    updatedAt: "",
    notesPath: "",
    planPath: "",
    contextPath: "",
    digestPath: "",
    planMeta: {
      version: 2,
      goalHash: "hash",
      reviewedAt: "",
      verdict: "ok" as const,
      requirements: ["movement", "win"],
      missing: [],
      assumptions: [],
      reviewCount: 1,
    },
    tasks: [
      { ...base, id: "task-1", title: "Shell", detail: "Build the shell", acceptance: "Shell works" },
      { ...base, id: "task-2", title: "Movement", detail: "Move the player", acceptance: "Player moves" },
      { ...base, id: "task-3", title: "Win", detail: "Show win", acceptance: "Win works" },
    ],
  };
  const collapsed = collapseToBuildSession(queue, analysis, queue.goal);
  assert.equal(collapsed.tasks.length, 1);
  assert.equal(collapsed.tasks[0].buildSession, true);
  assert.equal(collapsed.tasks[0].stepBudget, 20);
  assert.equal(collapsed.tasks[0].checklist?.length, 3);
  assert.match(collapsed.tasks[0].detail, /Movement/);
  assert.match(collapsed.tasks[0].detail, /ONE build session/);
  assert.equal(collapsed.planMeta?.requirements.length, 2);

  const tooLarge = {
    ...analysis,
    files: Array.from({ length: 13 }, (_, index) => ({ path: `f${index}.js`, bytes: 1_000 })),
  } as unknown as import("../../shared/types").AnalysisResult;
  assert.equal(isSmallProjectForBuildSession(tooLarge), false);
  assert.equal(collapseToBuildSession(queue, tooLarge, queue.goal).tasks.length, 3);

  const hasDone = { ...queue, tasks: [{ ...queue.tasks[0], status: "done" as const }, queue.tasks[1]] };
  assert.equal(collapseToBuildSession(hasDone, analysis, queue.goal).tasks.length, 2);
});

test("a failed planner still splits a large goal by its sections", () => {
  const goal = [
    "# NEON MAZE",
    "Build a small game.",
    "## Teknoloji",
    "- HTML",
    "- Vanilla JavaScript",
    "## Oyun mekaniği",
    "- Player moves with WASD",
    "- Walls block movement",
    "## Görsel tasarım",
    "- Dark background",
    "- Neon blue walls",
    "## Arayüz",
    "- Score",
    "- Start button",
    "## Kontroller",
    "- Walls block the player",
    "- Restart resets the game",
  ].join("\n");
  const tasks = splitGoalSections(goal);
  assert.ok(tasks);
  assert.equal(tasks.length, 4);
  assert.ok(tasks.some((task) => /Oyun mekaniği/.test(task.title) && task.surface === "game"));
  assert.ok(tasks.some((task) => /Görsel tasarım/.test(task.title) && task.surface === "ui"));
  const verify = tasks.find((task) => task.action === "verify");
  assert.ok(verify);
  assert.equal(verify.readOnly, true);
  // Tech constraints stay in every task detail.
  assert.ok(tasks.every((task) => /Vanilla JavaScript/.test(task.detail)));
});

test("review excerpts are marked when truncated so reviewers do not invent syntax errors", () => {
  const short = "body { color: red; }";
  assert.equal(reviewFileExcerpt(short), short);
  const truncated = reviewFileExcerpt("a".repeat(4_000));
  assert.match(truncated, /excerpt truncated; the file continues/);
  assert.equal(truncated.length < 4_000, true);
});

test("unverified Turkish summaries count as blockers", () => {
  assert.equal(
    summaryReportsBlocker(
      "Kod değişikliği gerekmedi. Ancak S/ArrowDown yönleri için doğrulanamayan kısım (bloker).",
    ),
    true,
  );
  assert.equal(
    summaryReportsBlocker("Tüm davranışlar doğrulandı; değişiklik gerekmedi."),
    false,
  );
  assert.equal(summaryReportsBlocker("The feature is unverified; no proof collected."), true);
});

test("typecheck is preferred over build for automatic verification", () => {
  assert.equal(
    preferredVerificationCommand({
      typecheckCommands: ["npx tsc --noEmit"],
      buildCommands: ["npm run build"],
    }),
    "npx tsc --noEmit",
  );
  assert.equal(
    preferredVerificationCommand({ typecheckCommands: [], buildCommands: ["cargo build"] }),
    "cargo build",
  );
  assert.equal(preferredVerificationCommand({ typecheckCommands: [], buildCommands: [] }), undefined);
  assert.equal(preferredVerificationCommand(undefined), undefined);
});

test("read range coverage prevents duplicate reads", () => {
  const ranges = [{ start: 1, end: 82, wholeFile: true }];
  assert.equal(readRangeCovered(ranges, 1, true, Number.POSITIVE_INFINITY), true);
  assert.equal(readRangeCovered(ranges, 70, false, 82), true);
  assert.equal(readRangeCovered(ranges, 1, false, 120), false);
  assert.equal(readRangeCovered(ranges, 83, false, 90), false);
  assert.equal(readRangeCovered([{ start: 40, end: 82, wholeFile: false }], 1, true, Number.POSITIVE_INFINITY), false);
});


test("remaining-work summaries are detected without flagging clean completions", () => {
  assert.equal(reportsRemainingWork("## Kalan (yapılmadı)\n- route wiring"), true);
  assert.equal(reportsRemainingWork("Kalan: createContainer and index.ts"), true);
  assert.equal(reportsRemainingWork("Remaining work: wire the route"), true);
  assert.equal(reportsRemainingWork("Next step: run tests"), true);
  assert.equal(reportsRemainingWork("Kalan yok, her şey tamam."), false);
  assert.equal(
    reportsRemainingWork("Proje dosyalarında değişiklik yapılmadı. Test PASSED."),
    false,
  );
  assert.equal(reportsRemainingWork("İş yapılmadı, route wiring eksik."), true);
  assert.equal(reportsRemainingWork("All changes are complete; typecheck passed."), false);
  assert.equal(
    reportsRemainingWork(
      "## Durum: uygulama yazıldı, kabul doğrulanmadı. Davranış kanıtlanamadı.",
    ),
    true,
  );
  assert.equal(reportsRemainingWork("Davranış doğrulandı; testler geçti."), false);
  assert.equal(
    reportsIncompleteWiring("index.html'de eksik kontrol veya bağlantı yok; tümü mevcut."),
    false,
  );
  assert.equal(
    reportsIncompleteWiring(
      "İstenen üç davranış da game.js içinde uygulandı. Bu görevde yeni bir form alanı, input veya markup eklenmesi gerekmiyor; harita listesi kaldırıldığı için eklenen kontrol yok, mevcut Start/Restart butonları kullanılıyor.",
    ),
    false,
  );
  assert.equal(
    reportsIncompleteWiring(
      "Harita listesi kaldırıldı; mevcut Start/Restart butonları kullanılıyor, yeni form alanı yok.",
      true,
    ),
    false,
  );
});

test("step-limit failures without edits retry with the edit-first fast profile", () => {
  assert.equal(shouldRetryWithEditFirst("max_steps", []), true);
  assert.equal(shouldRetryWithEditFirst("max_steps", ["js/script.js"]), false);
  assert.equal(shouldRetryWithEditFirst("finished", []), false);
  assert.equal(shouldRetryWithEditFirst("error", []), false);
});

test("inspection tasks are recognized and may finish without edits", () => {
  assert.equal(
    taskLooksLikeInspection({
      id: "task-1",
      title: "Inspect existing project files and structure",
      detail: "Read the files and report the structure.",
      readOnly: true,
      action: "other",
      status: "in_progress",
      effort: "standard",
      role: "main",
      dependsOn: [],
      attempts: 0,
      changedFiles: [],
      commands: [],
      createdAt: "",
      updatedAt: "",
    }),
    true,
  );
  assert.equal(
    taskLooksLikeInspection({
      id: "task-list",
      title: "dosyada eksik işleri başlıkları ve iş açıklamaları ile getirip listeler misin?",
      detail: "List the unchecked items.",
      readOnly: true,
      action: "other",
      status: "pending",
      effort: "standard",
      role: "main",
      dependsOn: [],
      attempts: 0,
      changedFiles: [],
      commands: [],
      createdAt: "",
      updatedAt: "",
    }),
    true,
  );
  assert.equal(
    taskLooksLikeInspection({
      id: "task-2",
      title: "Add date and time input fields",
      detail: "Implement the form changes.",
      action: "update",
      status: "pending",
      effort: "simple",
      role: "fast",
      dependsOn: [],
      attempts: 0,
      changedFiles: [],
      commands: [],
      createdAt: "",
      updatedAt: "",
    }),
    false,
  );
});

test("a failed task blocks its pending dependents instead of leaving the queue stuck", () => {
  const base = {
    version: 1 as const,
    projectId: "p",
    goal: "g",
    status: "running" as const,
    createdAt: "",
    updatedAt: "",
    notesPath: "",
    planPath: "",
    contextPath: "",
    digestPath: "",
  };
  const task = (id: string, dependsOn: string[], status: "failed" | "pending" | "done") => ({
    id,
    title: id,
    detail: id,
    status,
    effort: "standard" as const,
    role: "main" as const,
    dependsOn,
    attempts: 0,
    changedFiles: [],
    commands: [],
    createdAt: "",
    updatedAt: "",
  });
  const queue = {
    ...base,
    tasks: [
      task("a", [], "failed"),
      task("b", ["a"], "pending"),
      task("c", ["b"], "pending"),
      task("d", [], "pending"),
    ],
  };
  const blocked = blockDependentsOf(queue, "a");
  assert.equal(blocked.tasks.find((item) => item.id === "a")?.status, "failed");
  assert.equal(blocked.tasks.find((item) => item.id === "b")?.status, "blocked");
  assert.equal(blocked.tasks.find((item) => item.id === "c")?.status, "blocked");
  assert.equal(blocked.tasks.find((item) => item.id === "d")?.status, "pending");
});

test("inspection answers are accepted only when substantive", () => {
  assert.equal(
    isInspectionAnswer(
      "Here is the complete list of 19 items with headings and descriptions: " +
        "1) Terminal history, 2) verification, 3) streaming, 4) prompt test, " +
        "5) impact context, 6) clarification, 7) LSP, 8) rescan.",
    ),
    true,
  );
  assert.equal(
    isInspectionAnswer("The agent reached the step limit before finishing. Review the steps."),
    false,
  );
  assert.equal(isInspectionAnswer("Too short"), false);
  assert.equal(
    isInspectionAnswer(
      "Let me read the rest of index.html (120-134) and js/app.js to understand the form before I make the change.",
    ),
    false,
  );
});

test("a summary that admits missing markup is treated as incomplete", () => {
  assert.equal(
    reportsIncompleteWiring(
      "index.html içinde #task-assignee girdisinin tanımlı olduğuna dair bir gözlem yok; bu eleman HTML'de yoksa atama yapılamaz. Kabul kriterinin tam karşılanması için input'un eklenmesi gerekiyor.",
    ),
    true,
  );
  assert.equal(reportsIncompleteWiring("All changes are complete and verified."), false);
});

test("an edit task with inspection context is not a verification task", () => {
  const task = {
    id: "task-1",
    title: "form kısmında görev kişisi eklenmeli",
    detail: "Mevcut form yapısını inceleyerek alanı ekleyin.",
    action: "update" as const,
    verificationOnly: false,
    status: "pending" as const,
    effort: "simple" as const,
    role: "fast" as const,
    dependsOn: [],
    attempts: 0,
    changedFiles: [],
    commands: [],
    createdAt: "",
    updatedAt: "",
  };
  assert.equal(taskLooksLikeVerification(task), false);
  assert.equal(
    taskLooksLikeVerification({ ...task, action: "verify", verificationOnly: true }),
    true,
  );
  assert.equal(taskLooksLikeWrite(task), true);
});

test("ask mode is a cheap read-only task profile", () => {
  const intent = {
    kind: "question" as const,
    understanding: "answer a question",
    language: "tr",
    needsClarification: false,
    scope: "small" as const,
    mode: "single" as const,
    areas: [],
    verification: "none" as const,
    context: "project" as const,
    history: "none" as const,
    toolGroups: [],
    approach: "",
    needsExhaustiveEvidence: false,
    assumptions: [],
  };
  const task = intentTask("başka hangi alanlar eklenebilir?", intent, undefined, "ask");
  assert.equal(task.effort, "simple");
  assert.equal(task.role, "main");
  assert.equal(task.verification, undefined);
  assert.match(task.acceptance ?? "", /question is answered/i);
});

test("write detection uses structured task fields", () => {
  const base = {
    id: "task-1",
    title: "Do the work",
    detail: "",
    status: "pending" as const,
    effort: "simple" as const,
    role: "fast" as const,
    dependsOn: [],
    attempts: 0,
    changedFiles: [],
    commands: [],
    createdAt: "",
    updatedAt: "",
  };
  assert.equal(taskLooksLikeWrite({ ...base, action: "other", readOnly: true }), false);
  assert.equal(taskLooksLikeWrite({ ...base, action: "verify", readOnly: true }), false);
  assert.equal(taskLooksLikeWrite({ ...base, action: "update" }), true);
  assert.equal(taskLooksLikeWrite({ ...base, action: "create" }), true);
  assert.equal(taskLooksLikeWrite({ ...base, action: "run" }), false);
});

test("task budgets scale with effort and stop runaway usage", () => {
  assert.deepEqual(taskBudgetForEffort("simple"), { tokens: 80_000, costUsd: 0.05 });
  assert.deepEqual(taskBudgetForEffort("standard"), { tokens: 160_000, costUsd: 0.12 });
  assert.deepEqual(taskBudgetForEffort("hard"), { tokens: 320_000, costUsd: 0.25 });
  assert.equal(taskStepBudget("simple"), 10);
  assert.equal(taskStepBudget("standard"), 14);
  assert.equal(taskStepBudget("hard"), 20);
  assert.equal(
    budgetExceeded({ inputTokens: 0, outputTokens: 0, totalTokens: 80_001 }, undefined, 80_000),
    true,
  );
  assert.equal(
    budgetExceeded({ inputTokens: 0, outputTokens: 0, totalTokens: 10 }, 0.051, undefined, 0.05),
    true,
  );
  assert.equal(
    budgetExceeded({ inputTokens: 0, outputTokens: 0, totalTokens: 10 }, 0.01, 80_000, 0.05),
    false,
  );
});

test("verification runs typecheck, tests and lint before build", () => {
  const commands = preferredVerificationCommands({
    typecheckCommands: ["npx tsc --noEmit"],
    testCommands: ["npm test"],
    lintCommands: ["npm run lint"],
    buildCommands: ["npm run build"],
  });
  assert.deepEqual(commands, ["npx tsc --noEmit", "npm test", "npm run lint"]);
  assert.deepEqual(
    preferredVerificationCommands({ buildCommands: ["npm run build"] }),
    ["npm run build"],
  );
});

test("impact context includes callers and callees", () => {
  const analysis = {
    nodes: [
      { id: "caller", kind: "function", label: "callerFn", filePath: "src/a.ts", startLine: 10 },
      { id: "target", kind: "function", label: "targetFn", filePath: "src/b.ts", startLine: 20 },
      { id: "callee", kind: "function", label: "calleeFn", filePath: "src/c.ts", startLine: 30 },
    ],
    edges: [
      { kind: "CALLS", source: "caller", target: "target" },
      { kind: "CALLS", source: "target", target: "callee" },
    ],
  } as unknown as import("../../shared/types").AnalysisResult;
  const lines = impactContext(analysis, new Set(["target"]));
  assert.ok(lines.some((line) => line.includes("callerFn") && line.includes("targetFn")));
  assert.ok(lines.some((line) => line.includes("targetFn") && line.includes("calleeFn")));
});

test("intentTask adds conventional UI checks for a terse prompt", () => {
  const intent: IntentAnalysis = {
    kind: "edit" as const,
    understanding: "make the buttons blue",
    language: "tr",
    needsClarification: false,
    scope: "small" as const,
    mode: "single" as const,
    areas: ["index.html"],
    verification: "browser" as const,
    context: "focused" as const,
    history: "none" as const,
    toolGroups: ["edit", "browser"],
    approach: "",
    needsExhaustiveEvidence: false,
    assumptions: [],
    normalizedRequest: "Make the buttons dark blue.",
    behaviors: [
      {
        id: "b1",
        action: "update" as const,
        surface: "ui" as const,
        target: "buttons",
        details: "dark blue",
        acceptance: "buttons are dark blue",
      },
    ],
    constraints: ["do not change scoring"],
    confidence: 0.9,
  };
  const task = intentTask("butonları koyu mavi yap", intent, "npm run build", "build");
  assert.match(task.detail, /UI quality/i);
  assert.match(task.detail, /Preserve existing behavior/i);
  assert.match(task.detail, /Verification:/i);
  assert.equal(task.action, "update");
  assert.equal(task.surface, "ui");
  assert.equal(task.readOnly, false);
  assert.equal(task.patch, true);
  assert.equal(task.stepBudget, 8);
  assert.equal(task.effort, "simple");
  assert.equal(taskBudgetEffort(task), "simple");
  assert.match(task.detail, /Behaviors:/i);
  assert.match(task.detail, /do not change scoring/i);
  assert.match(task.acceptance ?? "", /buttons are dark blue/i);
  assert.match(task.acceptance ?? "", /UI quality is verified/i);
  assert.match(task.acceptance ?? "", /Verification \(npm run build\) passes/i);
});

test("summarizes successful verification steps for the stage trace", () => {
  const steps = [
    { index: 1, action: "browser_check", args: {}, observation: "", ok: true, durationMs: 1200 },
    { index: 2, action: "run_test_scenario", args: {}, observation: "", ok: true, durationMs: 800 },
    { index: 3, action: "browser_check", args: {}, observation: "", ok: false, durationMs: 500 },
    { index: 4, action: "read_file", args: {}, observation: "", ok: true, durationMs: 30 },
  ] as AiAgentStep[];
  assert.deepEqual(summarizeVerificationSteps(steps), { checks: 2, durationMs: 2000 });
});

test("structured task fields override legacy text heuristics", () => {
  const base = {
    id: "task-1",
    title: "Do the work and report it",
    detail: "Inspect and create a report",
    status: "pending" as const,
    effort: "simple" as const,
    role: "main" as const,
    dependsOn: [],
    attempts: 0,
    changedFiles: [],
    commands: [],
    createdAt: "",
    updatedAt: "",
  };
  assert.equal(taskLooksLikeWrite({ ...base, action: "verify", readOnly: true }), false);
  assert.equal(taskLooksLikeWrite({ ...base, action: "update" }), true);
  assert.equal(taskLooksLikeInspection({ ...base, action: "verify", readOnly: true }), true);
  assert.equal(taskLooksLikeVerification({ ...base, action: "verify", verificationOnly: true }), true);
  assert.equal(isMicroEditTask({ ...base, microEdit: true, detail: "unrelated" }), true);
});
