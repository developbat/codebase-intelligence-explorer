import { useEffect, useRef, useState } from "react";
import { Clapperboard, Pause, Play, RotateCcw, SkipForward, X } from "lucide-react";
import type { AnalysisResult, GitChangedFile, GitCommit, GitStatus } from "../../../shared/types";
import { api } from "../api";
import type { ViewMode } from "../lib/viewGraph";

export interface ShowcaseActions {
  setMode: (mode: ViewMode) => void;
  openFile: (filePath: string) => void;
  selectNode: (id: string | null) => void;
  setInspectorOpen: (open: boolean) => void;
  openCommit: (hash: string) => void;
  closeCommit: () => void;
  showCommitOnMap: (files: GitChangedFile[], commit: GitCommit) => void;
  ensureGitStatus: () => Promise<GitStatus | null>;
  setLocale: (locale: "en") => void;
}

interface ShowcaseDemoProps {
  open: boolean;
  analysis: AnalysisResult;
  actions: ShowcaseActions;
  onClose: () => void;
}

interface StepCaption {
  index: number;
  total: number;
  title: string;
  description: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function ShowcaseDemo({ open, analysis, actions, onClose }: ShowcaseDemoProps) {
  const [caption, setCaption] = useState<StepCaption | null>(null);
  const [paused, setPaused] = useState(false);
  const [finished, setFinished] = useState(false);
  const [runToken, setRunToken] = useState(0);
  const pausedRef = useRef(false);
  const cancelledRef = useRef(false);
  const skipRef = useRef(false);
  const actionsRef = useRef(actions);
  const analysisRef = useRef(analysis);

  actionsRef.current = actions;
  analysisRef.current = analysis;

  useEffect(() => {
    if (!open) {
      cancelledRef.current = true;
      setFinished(false);
      setCaption(null);
      return;
    }
    cancelledRef.current = false;
    pausedRef.current = false;
    setPaused(false);
    setFinished(false);
    setCaption(null);
    void runShowcase();
    return () => {
      cancelledRef.current = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, runToken]);

  async function wait(ms: number): Promise<boolean> {
    let remaining = ms;
    let last = Date.now();
    while (remaining > 0) {
      await sleep(70);
      if (cancelledRef.current) return false;
      if (skipRef.current) {
        skipRef.current = false;
        return true;
      }
      const now = Date.now();
      if (!pausedRef.current) remaining -= now - last;
      last = now;
    }
    return !cancelledRef.current;
  }

  async function showStep(
    index: number,
    total: number,
    title: string,
    description: string,
    duration: number,
    action?: () => void | Promise<void>,
  ): Promise<boolean> {
    if (cancelledRef.current) return false;
    setCaption({ index, total, title, description });
    await action?.();
    return wait(duration);
  }

  async function clickByText(selector: string, text: string): Promise<boolean> {
    for (let attempt = 0; attempt < 24; attempt += 1) {
      if (cancelledRef.current) return false;
      const target = [...document.querySelectorAll<HTMLElement>(selector)].find(
        (element) => element.textContent?.trim() === text,
      );
      if (target) {
        target.click();
        return true;
      }
      await sleep(100);
    }
    return false;
  }

  async function runShowcase() {
    const currentAnalysis = analysisRef.current;
    const currentActions = actionsRef.current;
    const gitAvailable = Boolean(currentAnalysis.git?.available);
    const total = gitAvailable ? 10 : 7;
    let step = 1;

    currentActions.setLocale("en");
    currentActions.closeCommit();

    const demoFile =
      [...currentAnalysis.files]
        .map((file) => ({
          file,
          symbols: currentAnalysis.symbols.filter((symbol) => symbol.filePath === file.path).length,
        }))
        .sort((a, b) => b.symbols - a.symbols)[0]?.file ?? currentAnalysis.files[0];

    const functionNodes = currentAnalysis.nodes
      .filter((node) => (node.kind === "function" || node.kind === "method") && node.filePath === demoFile?.path)
      .sort((a, b) => {
        const score = (node: typeof a) =>
          (typeof node.metadata?.callerCount === "number" ? node.metadata.callerCount : 0) * 3 +
          (typeof node.metadata?.callCount === "number" ? node.metadata.callCount : 0);
        return score(b) - score(a);
      });
    const demoFunction = functionNodes[0];
    const demoRoute =
      currentAnalysis.nodes.find((node) => node.kind === "route") ??
      currentAnalysis.nodes.find((node) => node.kind === "database") ??
      currentAnalysis.nodes.find((node) => node.kind === "event");

    if (
      !(await showStep(
        step,
        total,
        "A project, understood at a glance",
        `${currentAnalysis.projectName} · ${currentAnalysis.stats.files} files · ${currentAnalysis.stats.symbols} symbols`,
        6500,
        () => {
          currentActions.setMode("universe");
          currentActions.selectNode("project");
          currentActions.setInspectorOpen(true);
        },
      ))
    )
      return;
    step += 1;

    if (
      !(await showStep(
        step,
        total,
        "Navigate the whole architecture",
        "The project tree opens fully expanded, with search and instant project switching.",
        6500,
        () => {
          currentActions.setMode("files");
          currentActions.selectNode("project");
          currentActions.setInspectorOpen(true);
        },
      ))
    )
      return;
    step += 1;

    if (demoFile) {
      if (
        !(await showStep(
          step,
          total,
          "Follow real call chains",
          `${demoFile.path} · symbols, callers, and callees resolved from source evidence.`,
          8500,
          async () => {
            currentActions.openFile(demoFile.path);
            await sleep(900);
            currentActions.selectNode(demoFunction?.id ?? `file:${demoFile.path}`);
            currentActions.setInspectorOpen(true);
          },
        ))
      )
        return;
    }
    step += 1;

    if (
      !(await showStep(
        step,
        total,
        "See routes, data, and events together",
        demoRoute
          ? "Architecture view connects endpoints, database access, and event flow."
          : "Architecture view connects the project’s runtime surfaces.",
        7000,
        () => {
          currentActions.setMode("architecture");
          currentActions.selectNode(demoRoute?.id ?? null);
          currentActions.setInspectorOpen(Boolean(demoRoute));
        },
      ))
    )
      return;
    step += 1;

    if (gitAvailable) {
      if (
        !(await showStep(
          step,
          total,
          "Git intelligence, not just a diff",
          "Branch, HEAD, working-tree state, last commit, and a scrollable commit graph.",
          7000,
          async () => {
            currentActions.setMode("changes");
            currentActions.selectNode(null);
            await currentActions.ensureGitStatus();
            await sleep(900);
          },
        ))
      )
        return;
      step += 1;

      try {
        const history = await api.gitCommits(currentAnalysis.id, 1, 0);
        const latest = history.commits[0];
        if (latest) {
          const detail = await api.gitCommit(currentAnalysis.id, latest.hash);
          if (
            !(await showStep(
              step,
              total,
              "Open a commit like a map",
              `Changed-file tree, real diff, and graph impact for “${latest.subject}”.`,
              7500,
              () => {
                currentActions.openCommit(latest.hash);
                currentActions.setInspectorOpen(false);
              },
            ))
          )
            return;
          step += 1;

          if (
            !(await showStep(
              step,
              total,
              "Put the change back on the map",
              detail.files.length > 0
                ? `${detail.files.length} changed files highlighted on the 2D map.`
                : "The commit is shown with its graph impact.",
              7000,
              () => {
                currentActions.closeCommit();
                currentActions.showCommitOnMap(detail.files, detail.commit);
              },
            ))
          )
            return;
          step += 1;
        }
      } catch {
        // Git is optional; continue with the rest of the tour.
      }
    }

    if (
      !(await showStep(
        step,
        total,
        "Enter the 3D architecture",
        "A technical workspace with a subtle grid, architectural blocks, and zoom-based detail.",
        6500,
        () => {
          currentActions.setMode("3d");
          currentActions.setInspectorOpen(true);
        },
      ))
    )
      return;
    step += 1;

    if (
      !(await showStep(
        step,
        total,
        "Four ways to read a codebase",
        "Hybrid, hierarchical, clustered, and force-directed layouts — all from the same graph.",
        13500,
        async () => {
          await sleep(900);
          await clickByText(".u3d-layout-option", "Hierarchical");
          await sleep(2800);
          await clickByText(".u3d-layout-option", "Clustered");
          await sleep(2800);
          await clickByText(".u3d-layout-option", "Force");
          await sleep(3000);
          await clickByText(".u3d-layout-option", "Hybrid");
          await sleep(1200);
          if (demoFunction) {
            currentActions.selectNode(demoFunction.id);
            currentActions.setInspectorOpen(true);
          }
        },
      ))
    )
      return;
    step += 1;

    if (
      !(await showStep(
        step,
        total,
        "Saved projects stay in memory",
        "Every analysis is cached by project path. Switching opens it instantly — no rescan needed.",
        6500,
        async () => {
          document.querySelector<HTMLElement>(".project-switcher-trigger")?.click();
          await sleep(4000);
          document.querySelector<HTMLElement>(".project-switcher-trigger")?.click();
        },
      ))
    )
      return;

    setFinished(true);
    setCaption({
      index: total,
      total,
      title: "Codebase Intelligence Explorer",
      description: "Static facts, Git history, and 3D architecture in one local-first workspace.",
    });
  }

  if (!open) return null;

  const progress = caption ? Math.min(100, Math.round(((caption.index - 1) / caption.total) * 100)) : 0;

  function togglePause() {
    pausedRef.current = !pausedRef.current;
    setPaused(pausedRef.current);
  }

  function skip() {
    skipRef.current = true;
  }

  function exit() {
    cancelledRef.current = true;
    onClose();
  }

  function replay() {
    setFinished(false);
    setRunToken((value) => value + 1);
  }

  return (
    <div className="showcase-overlay">
      <div className="showcase-top-badge">
        <Clapperboard size={13} /> <span>GUIDED SHOWCASE</span>
        {paused ? <em>PAUSED</em> : null}
      </div>

      {finished ? (
        <div className="showcase-final">
          <div className="showcase-final-eyebrow">CODEBASE INTELLIGENCE EXPLORER</div>
          <h2>That is the explorer.</h2>
          <p>Read-only analysis, Git intelligence, project memory, and 2D/3D architecture.</p>
          <div className="showcase-final-actions">
            <button className="primary-button" onClick={replay}>
              <RotateCcw size={14} /> Replay
            </button>
            <button className="ghost-button" onClick={exit}>
              <X size={14} /> Close
            </button>
          </div>
        </div>
      ) : caption ? (
        <div className="showcase-caption">
          <div className="showcase-caption-head">
            <span className="showcase-step">
              STEP {caption.index} / {caption.total}
            </span>
            <span className="showcase-caption-brand">Codebase Intelligence Explorer</span>
          </div>
          <h3>{caption.title}</h3>
          <p>{caption.description}</p>
          <div className="showcase-progress">
            <span style={{ width: `${progress}%` }} />
          </div>
          <div className="showcase-controls">
            <button onClick={togglePause}>
              {paused ? <Play size={12} /> : <Pause size={12} />}
              {paused ? "Resume" : "Pause"}
            </button>
            <button onClick={skip}>
              <SkipForward size={12} /> Skip
            </button>
            <button onClick={exit}>
              <X size={12} /> Exit
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
