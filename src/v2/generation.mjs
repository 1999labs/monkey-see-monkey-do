// Record resolved wire budgets without credentials or arbitrary headers.
export function generationBudgets(config) {
  if (!config) return null;
  const adapter = config.adapter ?? 'openai';
  const parameter = adapter === 'responses' ? 'max_output_tokens' : ['openai','anthropic'].includes(adapter) ? 'max_tokens' : null;
  const limit = adapter === 'responses' ? config.maxOutputTokens ?? null
    : adapter === 'anthropic' ? config.maxTokens ?? 32000
    : adapter === 'openai' ? config.maxTokens ?? null : null;
  return {
    adapter, model: config.model,
    requestTimeoutMs: config.timeoutMs ?? 420000,
    maxRetries: config.maxRetries ?? 2,
    maxAttempts: (config.maxRetries ?? 2) + 1,
    outputTokens: {parameter, limit, source: limit === null ? 'provider-default' :
      (adapter === 'anthropic' && config.maxTokens == null ? 'adapter-default' : 'configured')},
    configured: {maxTokens:config.maxTokens??null,maxOutputTokens:config.maxOutputTokens??null,
      timeoutMs:config.timeoutMs??null,maxRetries:config.maxRetries??null},
  };
}
