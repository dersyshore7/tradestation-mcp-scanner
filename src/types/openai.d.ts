declare module "openai" {
  export interface OpenAiResponsesRequest {
    model: string;
    input: string;
  }

  export interface OpenAiResponsesResponse {
    output_text: string;
  }

  export default class OpenAI {
    constructor(config: { apiKey: string });
    responses: {
      create(request: OpenAiResponsesRequest): Promise<OpenAiResponsesResponse>;
    };
  }
}
