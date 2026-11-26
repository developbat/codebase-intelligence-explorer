import type { ProjectTaskQueue } from "../../../shared/tasks";
import { isContinuationInstruction } from "./intent";

export type TaskRelationKind =
  | "continue"
  | "reference"
  | "new_task"
  | "answer"
  | "chat"
  | "ambiguous";

export interface TaskRelationDecision {
  relation: TaskRelationKind;
  goal: string;
  history?: { role: "user" | "assistant"; content: string }[];
  /** Retry blocked/failed tasks in the existing queue. */
  retryFailed?: boolean;
  /** The short message answers a pending assistant/plan question. */
  clarified?: boolean;
  reason: string;
  confidence: number;
}

interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
}

const WORK_VERB =
  /\b(yap|yapıl|ekle|ekley|oluştur|olustur|güncelle|guncelle|değiştir|degistir|taşı|tasi|sil|düzelt|duzelt|ayarla|renklendir|çevir|cevir|istiyorum|add|implement|update|create|build|make|change|move|delete|fix|rename)\b/i;

const BARE_ACK =
  /^(listeyi|listeyi yap|listeyi uygula|hepsini yap|hepsini uygula|tümünü yap|tumunu yap|bunu yap|bunu uygula|aynısını yap|aynisini yap|devam|devam et|ok|okay|tamam|evet|yap|yapalım|yapalim|uygula|onayla|başla|basla|continue|go ahead|yes|apply|do it)[\s.!]*$/i;

const REFERENCE_WORD =
  /\b(liste|listeyi|bunu|bunları|bunlari|aynısını|aynisini|hepsini|tümünü|tumunu|yukarıdaki|yukaridaki|the list|that|it|them)\b/i;

const CONCRETE_TARGET =
  /[\w./-]+\.(?:js|mjs|cjs|jsx|ts|tsx|css|scss|html?|php|py|go|rs|java|kt|swift|dart|vue|svelte|json|md)\b|#[\w-]+|\b(başlı|basli|başlık|buton|tuş|tus|renk|skor|ikon|yazı|yazi|menü|menu|bölüm|bolum|düşman|dusman|envanter|kapı|kapi|anahtar|oyuncu|level|can|mermi|saldırı|saldiri)\b/i;

const QUESTION =
  /(\?\s*$|^(ne|neden|niçin|nicin|nasıl|nasil|nerede|ne zaman|kim|what|why|how|where|when|who)\b)/i;

function lastSubstantiveUser(
  history: HistoryMessage[] | undefined,
): { message: HistoryMessage; index: number } | null {
  if (!history) return null;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (message.role !== "user") continue;
    const content = message.content.trim();
    if (content.length < 12) continue;
    if (WORK_VERB.test(content) || /^\s*\d{1,2}[.)]\s+/m.test(content)) {
      return { message, index };
    }
  }
  return null;
}

function lastAssistant(history: HistoryMessage[] | undefined): HistoryMessage | null {
  if (!history) return null;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index].role === "assistant") return history[index];
  }
  return null;
}

function assistantAsked(history: HistoryMessage[] | undefined): boolean {
  const assistant = lastAssistant(history);
  if (!assistant) return false;
  const text = assistant.content.trim();
  return (
    /[?]\s*$/.test(text) ||
    /\b(onaylıyor musun|onayliyor musun|devam edeyim mi|ister misin|shall i|should i|do you want)\b/i.test(
      text,
    )
  );
}

function queueHasWork(queue?: ProjectTaskQueue | null): boolean {
  if (!queue) return false;
  if (queue.status === "completed") return false;
  return (
    queue.tasks.some((task) =>
      ["pending", "in_progress", "blocked", "failed"].includes(task.status),
    ) || queue.status === "running" || queue.status === "idle" || queue.status === "stopped"
  );
}

function queueHasFailed(queue?: ProjectTaskQueue | null): boolean {
  return Boolean(
    queue?.tasks.some((task) => task.status === "blocked" || task.status === "failed"),
  );
}

function trimAt(
  history: HistoryMessage[] | undefined,
  index: number,
): HistoryMessage[] | undefined {
  if (!history) return undefined;
  return history.slice(0, index);
}

export function decideTaskRelation(input: {
  instruction: string;
  history?: HistoryMessage[];
  queue?: ProjectTaskQueue | null;
}): TaskRelationDecision {
  const instruction = input.instruction.trim();
  const history = input.history;
  const queue = input.queue;
  const substantive = lastSubstantiveUser(history);
  const bare = BARE_ACK.test(instruction);
  const reference = REFERENCE_WORD.test(instruction);
  const concrete = CONCRETE_TARGET.test(instruction);
  const continuationPhrase = isContinuationInstruction(instruction);
  const question = QUESTION.test(instruction);

  if (!instruction) {
    return { relation: "chat", goal: instruction, reason: "Empty message.", confidence: 0.4 };
  }

  // A short answer to the assistant's own question is an answer, not a new job.
  if (assistantAsked(history) && (bare || /^(evet|hayır|hayir|no|yes|ok)\b/i.test(instruction))) {
    const fullGoal = queue && !isContinuationInstruction(queue.goal)
      ? queue.goal
      : substantive?.message.content ?? instruction;
    return {
      relation: "answer",
      goal: fullGoal,
      history: substantive ? trimAt(history, substantive.index) : [],
      retryFailed: queueHasFailed(queue),
      clarified: true,
      reason: "The short reply answers the pending assistant/plan question.",
      confidence: 0.85,
    };
  }

  // "devam", "ok", "listeyi yap" while an unfinished queue exists: continue
  // the queue instead of opening a new intent/planning session.
  if (queueHasWork(queue) && (bare || reference || continuationPhrase)) {
    // A queue whose goal is itself a continuation is the result of a bad
    // classification; use the previous substantive request instead.
    const queueGoal = queue?.goal ?? "";
    const effectiveGoal =
      queueGoal && !isContinuationInstruction(queueGoal)
        ? queueGoal
        : substantive?.message.content ?? (queueGoal || instruction);
    return {
      relation: "continue",
      goal: effectiveGoal,
      history: substantive ? trimAt(history, substantive.index) : [],
      retryFailed: queueHasFailed(queue),
      reason:
        "The message is an acknowledgement/continuation and an unfinished queue exists; resuming it instead of replanning.",
      confidence: 0.9,
    };
  }

  // "listeyi yap" / "hepsini yap" / "bunu yap" without a queue: resolve to the
  // previous substantive request. A list becomes the real goal, not a patch.
  if (bare || reference || continuationPhrase) {
    if (substantive) {
      return {
        relation: "reference",
        goal: substantive.message.content,
        history: trimAt(history, substantive.index),
        reason:
          "The message references the previous substantive request; that request is the goal.",
        confidence: 0.85,
      };
    }
    return {
      relation: "ambiguous",
      goal: instruction,
      history,
      reason: "A continuation was sent but there is no previous request or queue to continue.",
      confidence: 0.4,
    };
  }

  if (question) {
    return {
      relation: "chat",
      goal: instruction,
      history,
      reason: "The message is a question, not a project change.",
      confidence: 0.75,
    };
  }

  // A short but self-contained command with a concrete target ("başlığı mor
  // yap") is a new task. Classification into patch/build happens later from
  // the resolved behaviors, never from instruction length.
  if (concrete) {
    return {
      relation: "new_task",
      goal: instruction,
      history: [],
      reason:
        "The message has a concrete target, so it is a new task even when it is short.",
      confidence: 0.85,
    };
  }

  return {
    relation: "new_task",
    goal: instruction,
    history: instruction.length > 80 ? history : [],
    reason: "No continuation/reference signal; treating the message as a new task.",
    confidence: 0.7,
  };
}
