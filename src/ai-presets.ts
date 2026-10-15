import type { AiProtocol, AiSettings, MultimodalProtocol } from "./types";

export type AiProviderPresetId =
  | "openai"
  | "anthropic"
  | "gemini"
  | "zhipu"
  | "deepseek"
  | "qwen"
  | "moonshot"
  | "openrouter"
  | "custom";

export type AiProviderEditableField =
  | "providerName"
  | "baseUrl"
  | "protocol"
  | "model"
  | "multimodalEnabled"
  | "multimodalBaseUrl"
  | "multimodalProtocol"
  | "multimodalModel";

type AiProviderPreset = {
  id: AiProviderPresetId;
  label: string;
  providerName: string;
  baseUrl: string;
  protocol: AiProtocol;
  model: string;
  multimodalEnabled: boolean;
  multimodalBaseUrl: string;
  multimodalProtocol: MultimodalProtocol;
  multimodalModel: string;
};

const sameMultimodal = (baseUrl: string, model: string): Pick<
  AiProviderPreset,
  "multimodalEnabled" | "multimodalBaseUrl" | "multimodalProtocol" | "multimodalModel"
> => ({
  multimodalEnabled: true,
  multimodalBaseUrl: baseUrl,
  multimodalProtocol: "same",
  multimodalModel: model
});

export const AI_PROVIDER_PRESETS: readonly AiProviderPreset[] = [
  {
    id: "openai",
    label: "OpenAI",
    providerName: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    protocol: "openai-responses",
    model: "gpt-5.6",
    ...sameMultimodal("https://api.openai.com/v1", "gpt-5.6")
  },
  {
    id: "anthropic",
    label: "Anthropic Claude",
    providerName: "Anthropic Claude",
    baseUrl: "https://api.anthropic.com",
    protocol: "anthropic",
    model: "claude-sonnet-5",
    ...sameMultimodal("https://api.anthropic.com", "claude-sonnet-5")
  },
  {
    id: "gemini",
    label: "Google Gemini",
    providerName: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    protocol: "gemini",
    model: "gemini-3.6-flash",
    ...sameMultimodal("https://generativelanguage.googleapis.com/v1beta", "gemini-3.6-flash")
  },
  {
    id: "zhipu",
    label: "智谱 GLM Coding Plan",
    providerName: "智谱 GLM Coding Plan",
    baseUrl: "https://open.bigmodel.cn/api/anthropic",
    protocol: "anthropic",
    model: "glm-5.2",
    multimodalEnabled: true,
    multimodalBaseUrl: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    multimodalProtocol: "openai-chat",
    multimodalModel: "glm-5v-turbo"
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    providerName: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    protocol: "openai-chat",
    model: "deepseek-flash",
    multimodalEnabled: false,
    multimodalBaseUrl: "https://api.deepseek.com",
    multimodalProtocol: "same",
    multimodalModel: "deepseek-flash"
  },
  {
    id: "qwen",
    label: "通义千问",
    providerName: "通义千问",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    protocol: "openai-chat",
    model: "qwen3.6-plus",
    multimodalEnabled: false,
    multimodalBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    multimodalProtocol: "same",
    multimodalModel: "qwen3-vl-plus"
  },
  {
    id: "moonshot",
    label: "Moonshot Kimi",
    providerName: "Moonshot Kimi",
    baseUrl: "https://api.moonshot.cn/v1",
    protocol: "openai-chat",
    model: "kimi-k2.5",
    ...sameMultimodal("https://api.moonshot.cn/v1", "kimi-k2.5")
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    providerName: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    protocol: "openai-chat",
    model: "~openai/gpt-latest",
    ...sameMultimodal("https://openrouter.ai/api/v1", "~openai/gpt-latest")
  },
  {
    id: "custom",
    label: "Custom",
    providerName: "",
    baseUrl: "",
    protocol: "auto",
    model: "",
    multimodalEnabled: true,
    multimodalBaseUrl: "",
    multimodalProtocol: "same",
    multimodalModel: ""
  }
];

export const AI_PROTOCOL_OPTIONS: ReadonlyArray<{ value: AiProtocol; label: string }> = [
  { value: "auto", label: "自动识别" },
  { value: "openai-chat", label: "OpenAI Chat" },
  { value: "openai-responses", label: "OpenAI Responses" },
  { value: "anthropic", label: "Anthropic" },
  { value: "gemini", label: "Gemini" }
];

export const MULTIMODAL_PROTOCOL_OPTIONS: ReadonlyArray<{ value: MultimodalProtocol; label: string }> = [
  { value: "same", label: "与主模型相同" },
  ...AI_PROTOCOL_OPTIONS
];

export function applyAiPreset(current: AiSettings, presetId: AiProviderPresetId | string): AiSettings {
  const preset = AI_PROVIDER_PRESETS.find((item) => item.id === presetId) ?? AI_PROVIDER_PRESETS.at(-1)!;
  if (preset.id === "custom") return { ...current, providerPreset: "custom" };

  return {
    ...current,
    providerPreset: preset.id,
    providerName: preset.providerName,
    baseUrl: preset.baseUrl,
    protocol: preset.protocol,
    model: preset.model,
    multimodalEnabled: preset.multimodalEnabled,
    multimodalBaseUrl: preset.multimodalBaseUrl,
    multimodalProtocol: preset.multimodalProtocol,
    multimodalModel: preset.multimodalModel
  };
}

export function updateAiProviderField<K extends AiProviderEditableField>(
  current: AiSettings,
  field: K,
  value: AiSettings[K]
): AiSettings {
  return { ...current, [field]: value, providerPreset: "custom" } as AiSettings;
}
