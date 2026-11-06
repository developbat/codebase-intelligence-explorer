import type { LocaleInfo } from "../types";
import { tr } from "./tr";
import { de } from "./de";
import { fr } from "./fr";
import { es } from "./es";
import { pt } from "./pt";
import { ru } from "./ru";
import { zh } from "./zh";
import { ja } from "./ja";

const en = {} as Record<string, string>;

/**
 * Add a locale by creating a dictionary file and appending its LocaleInfo here.
 * Missing keys fall back to English, so translations can be added incrementally.
 */
export const LOCALES: LocaleInfo[] = [
  { id: "en", label: "English", nativeLabel: "English", dateLocale: "en-US", dictionary: en },
  { id: "tr", label: "Turkish", nativeLabel: "Türkçe", dateLocale: "tr-TR", dictionary: tr },
  { id: "de", label: "German", nativeLabel: "Deutsch", dateLocale: "de-DE", dictionary: de },
  { id: "fr", label: "French", nativeLabel: "Français", dateLocale: "fr-FR", dictionary: fr },
  { id: "es", label: "Spanish", nativeLabel: "Español", dateLocale: "es-ES", dictionary: es },
  { id: "pt", label: "Portuguese", nativeLabel: "Português", dateLocale: "pt-BR", dictionary: pt },
  { id: "ru", label: "Russian", nativeLabel: "Русский", dateLocale: "ru-RU", dictionary: ru },
  { id: "zh", label: "Chinese", nativeLabel: "中文", dateLocale: "zh-CN", dictionary: zh },
  { id: "ja", label: "Japanese", nativeLabel: "日本語", dateLocale: "ja-JP", dictionary: ja },
];

export const DEFAULT_LOCALE = "en";
