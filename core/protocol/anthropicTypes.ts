export interface AnthropicTextBlock { type: 'text'; text: string }
export interface AnthropicImageBlock { type: 'image'; source: { type: 'base64'; media_type: string; data: string } | { type: 'url'; url: string } }
export interface AnthropicToolUseBlock { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
export interface AnthropicToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content: string | Array<AnthropicTextBlock | AnthropicImageBlock>
  is_error?: boolean
}
export type AnthropicContentBlock = AnthropicTextBlock | AnthropicImageBlock | AnthropicToolUseBlock | AnthropicToolResultBlock

export interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: string | AnthropicContentBlock[]
}

export interface AnthropicTool {
  name: string
  description?: string
  input_schema: Record<string, unknown>
}

export interface AnthropicRequest {
  model: string
  max_tokens: number
  system?: string | AnthropicTextBlock[]
  messages: AnthropicMessage[]
  temperature?: number
  top_p?: number
  stop_sequences?: string[]
  stream?: boolean
  tools?: AnthropicTool[]
  tool_choice?: { type: 'auto' | 'any' | 'tool'; name?: string }
  metadata?: Record<string, unknown>
  thinking?: unknown
}

export interface AnthropicResponse {
  id: string
  type: 'message'
  role: 'assistant'
  model: string
  content: Array<AnthropicTextBlock | AnthropicToolUseBlock>
  stop_reason: 'end_turn' | 'max_tokens' | 'tool_use' | null
  stop_sequence: string | null
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number }
}
