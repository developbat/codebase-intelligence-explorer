export interface ClarificationOption {
  id: string;
  label: string;
  /** Text appended to the original instruction when the user picks this option. */
  instructionSuffix: string;
}

export interface ClarificationRequest {
  /** Human-readable question. Clients may translate it by using it as an i18n key. */
  question: string;
  options: ClarificationOption[];
  /** The original instruction that needs to be clarified. */
  original: string;
}

const TIME_WORD = /\b(saat|saatler|zaman|time)\b/i;
const TIME_QUALIFIER =
  /\b(oluştur|oluşturul|eklenme|kayıt|bitiş|bitis|hatırlat|hatirlat|alarm|süre|sure|başlangıç|baslangic|due|deadline|created|creation|reminder|timer|duration|start|end)\b/i;
const ADD_INTENT = /\b(ekle|eklen|koy|göster|goster|yaz|add|show|display|insert)\b/i;
const ACTION_WORD = /\b(ekle|düzelt|duzelt|değiştir|degistir|yap|fix|add|update|change|refactor)\b/i;
const CLARIFIED = /\b(netleştirme|netlestirme|clarification)\s*:/i;

function timeClarification(text: string): ClarificationRequest | null {
  if (!TIME_WORD.test(text) || !ADD_INTENT.test(text)) return null;
  if (TIME_QUALIFIER.test(text)) return null;
  return {
    question: "Saat özelliği tam olarak ne yapsın?",
    original: text,
    options: [
      {
        id: "creation",
        label: "Görev oluşturulma saati",
        instructionSuffix:
          "Netleştirme: Görev oluşturulduğu andaki saat kaydedilsin ve görev listesinde gösterilsin.",
      },
      {
        id: "due",
        label: "Bitiş / hatırlatma saati",
        instructionSuffix:
          "Netleştirme: Kullanıcı her görev için bitiş veya hatırlatma saati seçebilsin; süresi yaklaşınca uyarı gösterilsin.",
      },
      {
        id: "timer",
        label: "Geçen süre sayacı",
        instructionSuffix:
          "Netleştirme: Görev eklendiğinde geçen süre sayacı başlasın ve listede gösterilsin.",
      },
      {
        id: "assume",
        label: "En iyi yorumunla devam et",
        instructionSuffix:
          "Netleştirme: En iyi yorumunla ilerle ve seçtiğin yorumu plan özetinde açıkça belirt.",
      },
    ],
  };
}

/**
 * Zero-token intent check. It only asks when a short instruction has a genuinely
 * ambiguous object (for example, what a "time" field should mean). Clear
 * instructions are never interrupted.
 */
export function detectClarification(
  instruction: string,
  options: { askMode?: boolean } = {},
): ClarificationRequest | null {
  if (options.askMode) return null;
  const text = instruction.trim();
  if (!text || CLARIFIED.test(text)) return null;
  if (text.endsWith("?")) return null;

  const time = timeClarification(text);
  if (time) return time;

  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= 3 && ACTION_WORD.test(text)) {
    return {
      question: "Neyi eklemek veya değiştirmek istiyorsun? Dosya, ekran ve beklenen davranışı yaz.",
      original: text,
      options: [
        {
          id: "assume",
          label: "En iyi yorumunla devam et",
          instructionSuffix:
            "Netleştirme: En iyi yorumunla ilerle ve seçtiğin yorumu plan özetinde açıkça belirt.",
        },
      ],
    };
  }
  return null;
}
