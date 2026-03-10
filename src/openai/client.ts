const OPENAI_API_KEY_ENV_NAME = "OPENAI_API_KEY";

function getOpenAiApiKey(): string {
  const apiKey = process.env[OPENAI_API_KEY_ENV_NAME];

  if (!apiKey) {
    throw new Error(`Missing ${OPENAI_API_KEY_ENV_NAME} environment variable.`);
  }

  return apiKey;
}

export async function createOpenAiClient() {
  const { default: OpenAI } = await import("openai");

  return new OpenAI({ apiKey: getOpenAiApiKey() });
}
