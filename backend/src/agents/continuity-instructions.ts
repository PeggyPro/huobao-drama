/** App-level tool contract, applied after editable prompts in every content language. */
export const CONTINUITY_RELATION_RULES = `
段落衔接规则（作用于前段最后一个子镜头与本段第一个子镜头）：
- 首段必须独立生成，无来源。后续接续来源只能是紧邻的前一段，不跨集、不跳段。
- mode: independent（独立生成）、tail_frame（明确沿用前段尾帧构图）、motion_context（ComfyUI H3 延续动作）。
- relation: continuous_action、same_scene_cut、scene_change、time_change、unknown。
- 同场景换机位/特写/正反打通常 independent；同场景同机位连续动作才考虑 motion_context；换场景/换时间必须 independent。
- 以 read_storyboard_context 返回的视频模型能力为准；未知关系或未知能力使用 independent 并 needs_review=true，说明原因。
- start_state/end_state 简明记录人物位置朝向、姿态、视线、持物、动作进度和机位。
- video_prompt 写明开始/结束状态；接续段继续动作，不重复前段动作或台词；段落内部仍可按描述正常切换子镜头。
- 补写/重写 video_prompt 时遵守已保存的 continuity_plan，不改动衔接选择、不重拆分、不重复对白。
`

export const CONTINUITY_INSTRUCTIONS = `${CONTINUITY_RELATION_RULES}
- 保存新分镜时填写 continuity：mode、relation、source_shot_number、reason、needs_review、start_state、end_state。
- 独立生成时 source_shot_number=null；接续时为紧邻前段的 shot_number。
- 保存新分镜每批最多8段，第一批 replace_existing=true，后续省略；不得一次性输出超过8段。
`
