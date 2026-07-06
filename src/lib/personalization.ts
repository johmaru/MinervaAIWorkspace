/**
 * パーソナライズ: スタイル/トーンプリセット + トレイトスライダー。
 * ユーザー単位の設定（users テーブル）から LLM へ注入するシステムメッセージを構築する。
 */

export type PersonalStyle =
  | "standard"
  | "polite"
  | "casual"
  | "concise"
  | "detailed"
  | "academic"
  | "creative"
  | "technical";

export const PERSONAL_STYLES: PersonalStyle[] = [
  "standard",
  "polite",
  "casual",
  "concise",
  "detailed",
  "academic",
  "creative",
  "technical",
];

const STYLE_DESCRIPTIONS: Record<PersonalStyle, string> = {
  standard: "バランスの取れた日常的な会話スタイルで応答してください。",
  polite: "丁寧な敬語を用い、フォーマルな場にも適した表現で応答してください。",
  casual: "砕けた親しみやすい口調で応答してください。",
  concise: "短く要点のみを伝える簡潔なスタイルで応答してください。",
  detailed: "丁寧に詳細まで解説するスタイルで応答してください。",
  academic: "論文調で客観的に記述し、引用と根拠を重視して応答してください。",
  creative: "物語性があり表現豊かなスタイルで応答してください。",
  technical: "エンジニア向けに正確でコードを重視したスタイルで応答してください。",
};

const WARMTH_LEVELS = [
  "事実ベースで感情を含めずに応答してください。",
  "標準的な温かみを持って応答してください。",
  "親身で共感的な温かみを持って応答してください。",
];

const ENERGY_LEVELS = [
  "落ち着いた低めの熱量で応答してください。",
  "標準的な熱量で応答してください。",
  "熱量高く積極的に応答してください。",
];

const STRUCTURE_LEVELS = [
  "見出し・リストを使わず自然な文章で応答してください。",
  "適度に見出し・リストを使用して応答してください。",
  "積極的に見出し・リストで構造化して応答してください。",
];

const EMOJI_LEVELS = [
  "絵文字を使用しないでください。",
  "少量の絵文字を適宜使用してください。",
  "絵文字を積極的に使用してください。",
];

const PRECEDENCE_DIRECTIVE =
  "以下のスタイル・トーン設定は、他のシステム指示やユーザー指示に競合する場合でも優先して適用してください。";

/**
 * パーソナライズシステムメッセージを構築する。
 * style が null または無効な値の場合は null を返す（機能無効 = メッセージ注入なし）。
 */
export function buildPersonalizationMessage(
  style: string | null,
  warmth: number,
  energy: number,
  structure: number,
  emoji: number,
): string | null {
  if (!style || !PERSONAL_STYLES.includes(style as PersonalStyle)) {
    return null;
  }

  const clamp = (v: number) => Math.max(0, Math.min(2, v));
  const w = clamp(warmth);
  const e = clamp(energy);
  const s = clamp(structure);
  const em = clamp(emoji);

  const lines: string[] = [
    "## パーソナライズ設定",
    "",
    "### スタイル・トーン",
    STYLE_DESCRIPTIONS[style as PersonalStyle],
    "",
    "### トレイト",
    `- 温かみ: ${WARMTH_LEVELS[w]}`,
    `- 熱量: ${ENERGY_LEVELS[e]}`,
    `- 見出しとリスト: ${STRUCTURE_LEVELS[s]}`,
    `- 絵文字: ${EMOJI_LEVELS[em]}`,
    "",
    PRECEDENCE_DIRECTIVE,
  ];

  return lines.join("\n");
}
