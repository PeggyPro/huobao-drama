import type { Agent } from '@mastra/core/agent'
import type { RequestContext } from '@mastra/core/request-context'
import type { AgentRequestContextValues } from './context.js'

/** Keep the HTTP chat response as JSON while receiving long storyboard output incrementally. */
export async function runAgentChat(agent: Agent, message: string, requestContext: RequestContext<AgentRequestContextValues>) {
  const messages = [{ role: 'user' as const, content: message }]
  const options = { maxSteps: 20, requestContext }
  if (agent.id !== 'storyboard_breaker') return agent.generate(messages, options)

  // Non-streaming chat/completions can hit a gateway timeout while the model produces
  // descriptions and video prompts. Consume the stream fully so every tool step runs.
  const stream = await agent.stream(messages, options)
  const result = await stream.getFullOutput()
  // Stream failures may be returned in the output instead of rejecting its promise.
  // Never report success (or retry the whole run) after partially saved tool calls.
  if (result.error) throw result.error
  if (result.finishReason === 'error') throw new Error('分镜生成失败：文本模型流式响应异常')
  return result
}
