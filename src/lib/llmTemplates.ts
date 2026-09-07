/**
 * Well-known OpenAI-compatible LLM platforms for the Settings GUI.
 *
 * Selecting a platform in Settings → LLM auto-fills LLM_PROVIDER=openai and
 * LLM_BASE_URL. The baseUrl must match the platform's OpenAI-compatible
 * chat/completions endpoint exactly — the UI matches on this string.
 *
 * Only OpenAI-compatible endpoints belong here. Anthropic-format
 * (/v1/messages) and Responses-API (/v1/responses) platforms are NOT
 * supported by the openai provider and must stay out.
 */
export const LLM_PLATFORM_TEMPLATES = [
  { id: "umans",      name: "UmansAI",       baseUrl: "https://api.code.umans.ai/v1" },
  { id: "opencode",   name: "OpenCode Go",   baseUrl: "https://opencode.ai/zen/go/v1" },
  { id: "opencode-zen", name: "OpenCode Zen", baseUrl: "https://opencode.ai/zen/v1" },
  { id: "openai",     name: "OpenAI",        baseUrl: "https://api.openai.com/v1" },
  { id: "openrouter", name: "OpenRouter",     baseUrl: "https://openrouter.ai/api/v1" },
  { id: "groq",       name: "Groq",          baseUrl: "https://api.groq.com/openai/v1" },
  { id: "deepseek",   name: "DeepSeek",      baseUrl: "https://api.deepseek.com/v1" },
  { id: "mistral",    name: "Mistral",       baseUrl: "https://api.mistral.ai/v1" },
  { id: "xai",        name: "xAI",           baseUrl: "https://api.x.ai/v1" },
  { id: "gemini",     name: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" },
  { id: "github",     name: "GitHub Models", baseUrl: "https://models.github.ai/inference" },
] as const;

export type LlmPlatformId = (typeof LLM_PLATFORM_TEMPLATES)[number]["id"];
