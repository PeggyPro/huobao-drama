---
name: continuity-planner
description: 镜头衔接分析的实用判断准则与保存约束
---

# 镜头衔接分析指南

本 Skill 用于辅助 `continuity_planner` 判断两个相邻分镜段落的边界。它提供证据优先级、保守选择和小案例；任务步骤与工具调用顺序以 System Prompt 为准。

## 判断清单

1. 先确认两个分镜属于同一集，并且当前段紧邻前段。来源只能是同集紧邻前段的真实 `id`；不能用 `shot_number`，不能跳过中间段，也不能跨集。
2. 只看前段最后一个子镜头与当前段第一个子镜头。段落内部的切镜不属于本次分析。
3. 先确认画面证据，再确认视频能力。能力只认 `readStoryboardContext` 返回的 `video_model.supported_modes`。
4. 先选择关系，再选择模式：
   - 同场景换机位、换景别、特写、正反打通常是 `same_scene_cut` + `independent`。独立生成的来源必须是 `null`。
   - 同机位、动作在边界处确实连续才是 `continuous_action` + `motion_context`，并且必须有能力支持。
   - 当前段明确复用前段尾帧构图、人物位置和姿态才是 `tail_frame`，并且必须有能力支持。
   - 换场景是 `scene_change` + `independent`；换时间是 `time_change` + `independent`；两者来源都为 `null`。
   - 看不清或返回能力为空时用 `unknown` + `independent`，`needs_review: true`。
5. 状态描述至少检查：人物站位、朝向、姿态、视线、持物、动作完成度、机位。只写可从剧本或 `description` 读出的事实。缺少一项关键证据时，用“待核”标记，不补写想象细节，并把 `needs_review` 设为 `true`。
6. 首段永远是 `independent`、`source_storyboard_id: null`。即使上一段来自别集，也不能作为来源。

## 模式选择的边界

- `independent`：默认且最保守的模式，适用于普通切镜、场景/时间变化、关系不明、能力不支持或证据不足。
- `motion_context`：只用于同机位连续动作，例如镜头保持固定，中景人物抬手拿杯，下一段从同一机位继续把杯子送到唇边。若机位变成侧面或近景，应改为 `independent`。
- `tail_frame`：只用于明确要求从相同尾帧构图开始，例如上一段结束时人物停在画面右侧、右手举信，下一段第一帧仍保持该构图后再转身。仅有“同场景”或“动作相连”不足以使用尾帧。

## 小案例

### 同场景换机位
前段最后子镜头是客厅中景，人物放下电话；当前段第一子镜头是同一客厅的侧面近景，人物抬眼。建议：`relation: same_scene_cut`、`mode: independent`、`source_storyboard_id: null`。理由写清楚机位改变，不要把它误判为动作上下文。

### 同机位连续动作
前段在固定中景中记录人物伸手拿起杯子，当前段从同一固定中景开始，手仍在上移且没有重演动作。只有 `supported_modes` 含 `motion_context` 时，建议 `relation: continuous_action`、`mode: motion_context`、来源为前段真实 ID；否则改为 `independent`、来源 `null`、`needs_review: true`。

### 明确承接尾帧
前段结尾给出人物站位、朝向和手中物的清晰构图，当前段明确要求从这一个构图继续。只有能力列表支持 `tail_frame` 时才使用 `tail_frame`；否则使用独立生成并说明能力不足。

### 换场景或换时间
从夜间厨房切到清晨街道，或同一地点从当晚跳到第二天。建议分别使用 `scene_change` 或 `time_change` 与 `independent`，来源 `null`，不要试图用尾帧或动作上下文跨越变化。

### 证据不足
前段只写“他走出去”，当前段写“他回头”，没有站位、方向、机位或时间证据。使用 `relation: unknown`、`mode: independent`、来源 `null`、`needs_review: true`，在 `reason` 记录缺失证据。

### 对白桥接
对白内容可以在 `reason` 中作为叙事连续性的辅助证据，例如同一事件的问答跨段承接；这不等于画面连续，也不能承诺音频无缝、J-cut 或任何音频转场。仍按画面关系选择模式，不调用导出转场工具。

## 保存检查

使用 `saveContinuity` 时，批次为 1-8 条，覆盖全部目标且不重复。每项必须按以下结构传递，并使用从 `readStoryboardContext` 读取的当前 revision：

```json
{
  "storyboard_id": 123,
  "continuity_revision": 0,
  "continuity_plan": {
    "mode": "independent",
    "relation": "unknown",
    "source_storyboard_id": null,
    "reason": "证据不足，待人工核对",
    "needs_review": true,
    "start_state": "待核：…",
    "end_state": "待核：…"
  }
}
```

不要增加或修改 manual 选择、revision、剧本、分镜描述、视频提示词、视频文件或导出转场。已有人工选择由服务保留，AI 分析只能新增 suggestion。一般参数错误可按工具反馈修正，并只继续未保存的目标；若发生 revision 冲突，应停止本次分析，提示刷新后重试，保留已成功保存的建议，并说明本次未完整成功。不能捏造成功。