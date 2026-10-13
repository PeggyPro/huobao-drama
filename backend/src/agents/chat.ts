import type { Agent } from '@mastra/core/agent'
import type { RequestContext } from '@mastra/core/request-context'
import type { AgentRequestContextValues } from './context.js'
import { logTaskProgress } from '../utils/task-logger.js'

const storyboardToolNames = [
  'readStoryboardContext', 'saveStoryboards', 'updateStoryboard',
  'read_storyboard_context', 'save_storyboards', 'update_storyboard',
]

function record(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try { return record(JSON.parse(value)) } catch { return {} }
  }
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function toolPayload(entry: unknown) {
  const outer = record(entry)
  return outer.payload ? record(outer.payload) : outer
}

function toolTargets(name: string, input: unknown): string[] {
  const args = record(input)
  if (name === 'readStoryboardContext' || name === 'read_storyboard_context') return ['read-context']
  if (name === 'updateStoryboard' || name === 'update_storyboard') {
    return typeof args.storyboard_id === 'number' ? [`update:${args.storyboard_id}`] : []
  }
  if (name === 'saveStoryboards' || name === 'save_storyboards') {
    if (!Array.isArray(args.storyboards) || !args.storyboards.length) return []
    const numbers = args.storyboards.map(shot => record(shot).shot_number)
    return numbers.every(number => typeof number === 'number' && Number.isFinite(number))
      ? numbers.map(number => `save:${number}`) : []
  }
  return []
}

// Full output uses payload.result; stopWhen uses AI SDK output { type, value }.
export function toolOutcome(entry: unknown) {
  const payload = toolPayload(entry)
  const output = record(payload.result ?? payload.output)
  const wrapped = typeof output.type === 'string' && 'value' in output
  const result = wrapped ? record(output.value) : output
  const name = String(payload.toolName ?? '')
  const failed = payload.isError === true || Boolean(result.error)
    || output.type === 'error-json' || output.type === 'error-text'
  const message = typeof result.error === 'string' ? result.error
    : typeof result.message === 'string' ? result.message
      : failed && typeof output.value === 'string' ? output.value : '工具调用失败'
  const saved = (name === 'saveStoryboards' || name === 'save_storyboards')
    && !failed && typeof result.count === 'number' && result.count > 0
  return { id: String(payload.toolCallId ?? ''), name, failed, message, saved }
}

/** Keep the HTTP chat response as JSON while receiving long script/storyboard output incrementally. */
export async function runAgentChat(agent: Agent, message: string, requestContext: RequestContext<AgentRequestContextValues>) {
  const messages = [{ role: 'user' as const, content: message }]
  const options = { maxSteps: 20, requestContext }
  if (agent.id === 'script_rewriter') {
    // Buffered completions can hit the HTTP headers timeout while the model writes
    // a long screenplay. Consume the stream, including complete save_script calls.
    const stream = await agent.stream(messages, options)
    const result = await stream.getFullOutput()
    // A stream failure must not look successful or replay an already executed save.
    if (result.error) throw result.error
    if (result.finishReason === 'error') throw new Error('剧本改写失败：文本模型流式响应异常')
    return result
  }
  if (agent.id !== 'storyboard_breaker') return agent.generate(messages, options)

  // Only database tools can fulfill this request. Workspace file writes are not a save.
  const stream = await agent.stream(messages, {
    ...options,
    activeTools: storyboardToolNames,
    // Batches must execute in order: a replacing batch cannot race an append.
    toolCallConcurrency: 1,
    // Allow one correction, but never spend all 20 steps repeating invalid arguments.
    stopWhen: ({ steps }: { steps: Array<{ toolResults: readonly unknown[] }> }) => {
      let consecutiveFailures = 0
      for (const step of steps) {
        for (const entry of step.toolResults) {
          consecutiveFailures = toolOutcome(entry).failed ? consecutiveFailures + 1 : 0
          if (consecutiveFailures >= 2) return true
        }
      }
      return false
    },
    onStepFinish: (step) => {
      const outcomes = step.toolResults.map(toolOutcome)
      if (!outcomes.length) return
      logTaskProgress('Agent', 'storyboard-step', {
        tools: outcomes.map(outcome => outcome.name),
        savedBatches: outcomes.filter(outcome => outcome.saved).length,
        failures: outcomes.filter(outcome => outcome.failed).map(outcome => outcome.message.slice(0, 300)),
      })
    },
  })
  const result = await stream.getFullOutput()
  // Stream failures may be returned in the output instead of rejecting its promise.
  // Never retry the whole run after partially saved tool calls.
  if (result.error) throw result.error
  if (result.finishReason === 'error') throw new Error('分镜生成失败：文本模型流式响应异常')

  const outcomes = result.toolResults.map(toolOutcome)
  const saved = outcomes.some(outcome => outcome.saved)
  const inputs = new Map(result.toolCalls.map(entry => {
    const call = toolPayload(entry)
    return [String(call.toolCallId ?? ''), call.args ?? call.input]
  }))
  const failures: Array<{ outcome: ReturnType<typeof toolOutcome>; pending: Set<string> | null }> = []
  for (const outcome of outcomes) {
    const targets = toolTargets(outcome.name, inputs.get(outcome.id))
    if (outcome.failed) {
      failures.push({ outcome, pending: targets.length ? new Set(targets) : null })
    } else if (outcome.saved || outcome.name === 'readStoryboardContext' || outcome.name === 'read_storyboard_context'
      || outcome.name === 'updateStoryboard' || outcome.name === 'update_storyboard') {
      // A later batch only repairs failures for the same shots, never a skipped batch.
      for (const failure of failures) {
        for (const target of targets) failure.pending?.delete(target)
      }
    }
  }
  const unresolved = failures.find(failure => failure.pending === null || failure.pending.size > 0)
  if (unresolved) {
    const failure = unresolved.outcome
    throw new Error(`分镜生成失败：${failure.name}：${failure.message.slice(0, 400)}${saved ? '；部分分镜已保存，整集生成未完成' : '；本次未成功保存分镜'}`)
  }
  if (!saved) throw new Error('分镜生成失败：模型未成功保存任何分镜，请重试或更换文本模型')
  if (result.finishReason === 'tool-calls' || result.finishReason === 'length') {
    throw new Error('分镜生成失败：已达到生成步数或输出上限；部分分镜已保存，整集生成未完成')
  }
  return result
}
