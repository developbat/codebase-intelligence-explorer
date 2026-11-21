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
const ADD_INTENT = /\b(ekle|ekley|eklen|ekleme|koy|göster|goster|yaz|add|show|display|insert)\w*/i;
const ACTION_WORD = /\b(ekle|düzelt|duzelt|değiştir|degistir|yap|fix|add|update|change|refactor)\b/i;
const CLARIFIED = /\b(netleştirme|netlestirme|clarification)\s*:/i;
const FIELD_ADD = /\b(bir alan|yeni bir alan|alan daha|another field|new field|field)\b/i;
const DETAIL_FIELD = /\b(görev detay|gorev detay|detay alan|detay field|açıklama alan|aciklama alan|task detail|description field)\b/i;
const FIELD_SHAPE = /\b(textarea|metin alan|çok satır|panel|modal|görünüm|gorunum|view|drawer)\b/i;

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

function detailFieldClarification(text: string): ClarificationRequest | null {
  if (!DETAIL_FIELD.test(text) || !ADD_INTENT.test(text)) return null;
  if (FIELD_SHAPE.test(text)) return null;
  return {
    question: "Görev detayı nasıl çalışsın?",
    original: text,
    options: [
      {
        id: "textarea",
        label: "Çok satırlı detay alanı",
        instructionSuffix:
          "Netleştirme: Görev ekleme formuna çok satırlı bir 'Görev detayı' metin alanı ekle; detay isteğe bağlı olsun ve görev listesinde görev metninin altında gösterilsin.",
      },
      {
        id: "panel",
        label: "Ayrı detay görünümü",
        instructionSuffix:
          "Netleştirme: Göreve tıklanınca ayrı bir detay panelinde görev detayını göster; görev ekleme formuna detay metni girilebilen bir alan ekle.",
      },
      {
        id: "both",
        label: "İkisi birlikte",
        instructionSuffix:
          "Netleştirme: Görev ekleme formuna çok satırlı detay alanı ekle; detayı listede göster ve tıklanınca ayrı detay panelinde de aç.",
      },
      {
        id: "assume",
        label: "En iyi yorumunla devam et",
        instructionSuffix:
          "Netleştirme: En iyi yorumunla ilerle ve seçtiğin alan tipini plan özetinde açıkça belirt.",
      },
    ],
  };
}

function genericFieldClarification(text: string): ClarificationRequest | null {
  if (!FIELD_ADD.test(text) || !ADD_INTENT.test(text)) return null;
  if (DETAIL_FIELD.test(text)) return null;
  return {
    question: "Hangi alan eklensin?",
    original: text,
    options: [
      {
        id: "detail",
        label: "Görev detayı",
        instructionSuffix:
          "Netleştirme: Görev ekleme formuna çok satırlı bir 'Görev detayı' metin alanı ekle; detay isteğe bağlı olsun ve görev listesinde görev metninin altında gösterilsin.",
      },
      {
        id: "priority",
        label: "Öncelik",
        instructionSuffix:
          "Netleştirme: Görev ekleme formuna Düşük/Normal/Yüksek seçenekli bir öncelik alanı ekle ve listele.",
      },
      {
        id: "label",
        label: "Etiket",
        instructionSuffix:
          "Netleştirme: Görev ekleme formuna serbest metin etiket alanı ekle ve listele.",
      },
      {
        id: "due",
        label: "Bitiş tarihi",
        instructionSuffix:
          "Netleştirme: Görev ekleme formuna bitiş tarihi/saati alanı ekle ve listele.",
      },
      {
        id: "assume",
        label: "En iyi yorumunla devam et",
        instructionSuffix:
          "Netleştirme: En iyi yorumunla ilerle ve seçtiğin alanı plan özetinde açıkça belirt.",
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

  const detail = detailFieldClarification(text);
  if (detail) return detail;

  const field = genericFieldClarification(text);
  if (field) return field;

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
