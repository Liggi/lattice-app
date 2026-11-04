// Vendor words as their makers write them; any other word is capitalised.
const VENDOR_CASE: Record<string, string> = {
  deepseek: 'DeepSeek', kimi: 'Kimi', qwen: 'Qwen', glm: 'GLM', gpt: 'GPT', llama: 'Llama',
  mistral: 'Mistral', gemini: 'Gemini', gemma: 'Gemma', grok: 'Grok', minimax: 'MiniMax', phi: 'Phi',
};

/** "deepseek-v4.1-flash" -> "DeepSeek V4.1 Flash"; a vendor prefix ("moonshotai/") and a "[1m]" suffix are dropped. */
export function endpointModelName(id: string): string {
  const name = id.replace(/\[[^\]]*\]$/, '').split('/').pop() ?? id;
  return name
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => VENDOR_CASE[word.toLowerCase()]
      ?? (/^[a-z]\d/i.test(word) ? word.toUpperCase() : word[0].toUpperCase() + word.slice(1)))
    .join(' ');
}
