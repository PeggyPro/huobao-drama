# Huobao 成片质量、镜头衔接与提示词审查

本次目标是先确认问题，不修改代码。本次没有修改业务代码、数据库或配置，没有重新调用付费生成接口；这份 Markdown 是补发的审查结果。

审查范围：本地第 1 集分镜与 14 条已生成视频的抽帧和媒体参数、第 3 集的 32 条分镜提示词、实际提交给 H3 的任务参数，以及对应的分镜、提示词、接续和导出实现。

**结论：镜头衔接差有实际画面依据，提示词也存在编排与同步问题。仅润色措辞不足以解决全部缺陷。**

**1. 相邻镜头的空间关系没有保持住。**

张府门前的相邻两段起始画面中，第 2 段的管家站在阶下前景，第 3 段又站在门口高阶，其他人物也被重新安排了位置。

![相邻两段起始画面的空间关系对比](<C:/Users/fuhan/AppData/Local/Temp/huobao-readonly-audit-srycv0ve/spatial-continuity-evidence.png>)

当前模板通常将同场景换机位、特写、正反打设为 independent。独立生成本身适合切换机位，但该模式会清空来源，实际生成请求不会自动携带前段结束状态或真实尾帧，主要依靠本段文字和身份参考图。参考图能帮助保持长相，不能保证上一镜的站位、视线和持物状态。

证据：[video-task-input.ts:138](<C:/Users/fuhan/Documents/github/huobao-drama/backend/src/services/video-task-input.ts#L138>)、[continuity-contract.ts:48](<C:/Users/fuhan/Documents/github/huobao-drama/backend/src/services/continuity-contract.ts#L48>)。

同时，接续功能真实存在且有生效：抽帧中，第 10→11、11→12、13→14 段使用动作上下文或尾帧后，构图衔接更稳定。不能将所有 independent 都判错，也不能说接续功能完全未应用。

**2. 提示词模板将精确剪辑和表演编排同时交给视频模型。**

模板要求每次生成 8–15 秒、包含 2–4 个子镜头，再按每 3 秒一行编排。一次请求同时承担多人身份一致、动作、对白、运镜和精确切镜，执行负担较重。

真实提示词把一句对白拆成：

- 6–9 秒：“是个北面的逃难女，凑了”
- 9–12 秒：“五两银子，杀婆子分走三两，”

后面又补充“不另起停顿”。模板在按固定时间格子组织语句，限制了自然的表演和说话节奏。

证据：[storyboard_breaker.md:8](<C:/Users/fuhan/Documents/github/huobao-drama/backend/workspace/prompts/storyboard_breaker.md#L8>)、[时间段规则:43](<C:/Users/fuhan/Documents/github/huobao-drama/backend/workspace/prompts/storyboard_breaker.md#L43>)。

这是已确认的设计风险；具体质量影响需要对照生成才能量化，尚不能将所有切镜失败归因于这条规则。

**3. 视频提示词与衔接计划没有同步，实际输入混入未定稿内容。**

第 1 段正文已经写明“双手空着放在身体两侧”，实际请求末尾仍追加“待核：首镜双手位置与持物情况未交代”。结束状态同样出现正文已指定膝旁、追加计划仍写具体位置待核的情况。

重写提示词时只保存 video_prompt，原衔接计划保留；生成阶段再将两份内容拼起来。该路径缺少对两者语义一致性的检查。

证据：[prompt_generator.md:29](<C:/Users/fuhan/Documents/github/huobao-drama/backend/workspace/prompts/prompt_generator.md#L29>)、[video-task-input.ts:143](<C:/Users/fuhan/Documents/github/huobao-drama/backend/src/services/video-task-input.ts#L143>)。

样本请求还统一追加了 604 字符的英文风格前缀，其中包含 animation still 等静态画面词。视频提示词没有充分按用途精炼；但尚未通过对照实验确认这段风格词直接降低了质量。

**4. 任务成功不等于内容连续性通过检查。**

完成检查主要确认媒体可读、尺寸帧率和上下文资源有效，没有检查人物是否真的达到声明的结束姿态、视线与持物状态。下一段可能沿用计划中的状态，而非上一段实际生成出的状态。

证据：[video-task-worker.ts:83](<C:/Users/fuhan/Documents/github/huobao-drama/backend/src/services/video-task-worker.ts#L83>)。

重新分析衔接主要更新规划元数据，不会自动修正提示词或已有视频。因此，分析成功不代表成片衔接已修好。

**5. 两个生成参数问题已由实际文件验证。**

| 项目 | 设置或请求 | 实测结果 |
|---|---|---|
| 生成分辨率 | 剧集设置 720p | 14 条视频全部为 960×544，24fps |
| 两条动作接续视频 | 请求 15 秒 | 实际均约 14.167 秒 |

分辨率问题：当前 H3 工作流固定为横屏 16:9、0.5MP，适配器没有把剧集分辨率及画幅注入相关节点。导出时放大或补边不能恢复生成阶段缺失的细节。

证据：[H3 工作流:17](<C:/Users/fuhan/Documents/github/huobao-drama/comfyui_workflows/huobao_32gb/huobao_minimax_h3_reference_turbo_api.json#L17>)、[工作流冻结:361](<C:/Users/fuhan/Documents/github/huobao-drama/backend/src/services/adapters/comfyui.ts#L361>)。

时长问题：15 秒请求按工作流公式得到 362 帧；动作接续裁掉约 22 帧上下文，剩 340 帧，340÷24≈14.1667 秒，与两条实际文件吻合。裁掉重复上下文本身合理，缺口是净时长未补偿或明确提示。音画一起裁剪，不能将其称为已证实的音画漂移。

证据：[工作流帧数公式:222](<C:/Users/fuhan/Documents/github/huobao-drama/comfyui_workflows/huobao_32gb/huobao_minimax_h3_reference_turbo_api.json#L222>)、[动作上下文注入:175](<C:/Users/fuhan/Documents/github/huobao-drama/backend/src/services/adapters/comfyui-reference.ts#L175>)。

**额外确认的条件性风险。**

前段从 A1 换成 A2 后，承接 A1 的后段 B 仍可与 A2 一起导出。前端能够提示来源陈旧，但导出预检未强制检查最终选段之间的来源版本一致性。此次没有证据证明现成样本发生了这种混用。

证据：[前端来源检查:103](<C:/Users/fuhan/Documents/github/huobao-drama/frontend/app/utils/continuity.ts#L103>)、[导出预检:148](<C:/Users/fuhan/Documents/github/huobao-drama/backend/src/services/ffmpeg-merge.ts#L148>)。

**建议修复顺序。**

1. 统一相邻镜头的空间关系、首尾状态和来源版本。
2. 收敛一次生成的任务复杂度，同步视频提示词与衔接计划。
3. 修正分辨率、画幅和接续视频的净时长。
4. 增加实际成片边界检查，区分任务完成与内容通过验收。

本次未对音色变化进行完整试听，也未开展不同文本模型或视频模型的对照实验，因此不把这些因素列为已证实的成因。
