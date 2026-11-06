import { HelpCircle } from "lucide-react";
import { driver, type DriveStep } from "driver.js";
import "driver.js/dist/driver.css";
import { useI18n } from "../i18n";

export function TourButton() {
  const { t } = useI18n();

  function startTour() {
    const steps = ([
      {
        popover: {
          title: t("Welcome to Codebase Intelligence Explorer"),
          description: t(
            "This short tour shows how to move from a project folder to files, symbols, call graphs, Git changes, and the 3D explorer.",
          ),
        },
      },
      {
        element: '[data-tour="open-project"]',
        popover: {
          title: t("Open a project"),
          description: t("Paste a path or use Browse… to pick a local folder. Scanning is read-only."),
          side: "right",
        },
      },
      {
        element: '[data-tour="project-switcher"]',
        popover: {
          title: t("Switch projects instantly"),
          description: t(
            "The active project card at the top lists every saved analysis. Switching opens its saved memory; it does not rescan.",
          ),
          side: "right",
        },
      },
      {
        element: '[data-tour="view-tabs"]',
        popover: {
          title: t("Six ways to explore"),
          description: t(
            "Universe shows modules, Files shows the tree, Calls shows functions, Architecture shows routes and data, Changes shows Git impact, and 3D gives you the spatial view.",
          ),
          side: "right",
        },
      },
      {
        element: '[data-tour="tree"]',
        popover: {
          title: t("The full project tree is open"),
          description: t(
            "All branches start expanded. Use the chevrons to expand or collapse everything, and click a file to jump into its function map.",
          ),
          side: "right",
        },
      },
      {
        element: '[data-tour="canvas"]',
        popover: {
          title: t("Explore the graph"),
          description: t(
            "Click a node to inspect it and light up its direct connections. Double-click a file or folder to go deeper.",
          ),
          side: "left",
        },
      },
      {
        element: '[data-tour="inspector"]',
        popover: {
          title: t("Read the evidence"),
          description: t(
            "The inspector shows the source, relationships, Git diff, and optional AI explanation for the selected entity.",
          ),
          side: "left",
        },
      },
      {
        element: '[data-tour="changes"]',
        popover: {
          title: t("Review changes"),
          description: t(
            "Changes shows the current branch, HEAD, the last commit, the commit graph, working-tree state, structural diff, and impact analysis.",
          ),
          side: "right",
        },
      },
      {
        element: '[data-tour="ai-setup"]',
        popover: {
          title: t("Optional AI layer"),
          description: t(
            "Connect OpenAI, Claude, DeepSeek, OpenRouter, Gemini, NVIDIA, or a custom endpoint. Keys stay local.",
          ),
          side: "bottom",
        },
      },
      {
        element: '[data-tour="3d"]',
        popover: {
          title: t("Enter 3D"),
          description: t("The same graph becomes a spatial scene. The button toggles back to 2D in place."),
          side: "right",
        },
      },
    ] as DriveStep[]).filter(
      (step) => !step.element || typeof step.element !== "string" || Boolean(document.querySelector(step.element)),
    );

    driver({
      showProgress: true,
      overlayOpacity: 0.62,
      stagePadding: 6,
      smoothScroll: true,
      popoverClass: "cie-tour-popover",
      nextBtnText: t("Next"),
      prevBtnText: t("Previous"),
      doneBtnText: t("Done"),
      progressText: t("{{current}} of {{total}}"),
      steps,
    }).drive();
  }

  return (
    <button
      className="icon-button topbar-icon"
      onClick={startTour}
      title={t("Take a tour")}
      aria-label={t("Take a tour")}
    >
      <HelpCircle size={15} />
    </button>
  );
}
