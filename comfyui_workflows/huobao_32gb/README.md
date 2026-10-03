# Huobao 32GB ComfyUI workflows

这个目录保存四套给火宝使用的 ComfyUI **API 格式**工作流：Qwen Image 2.1 和 Z-Image 图片、Wan 2.2 5B 视频、MiniMax H3 Turbo 视频。本机已配置对应服务；参考图片和续接首帧由火宝在提交时上传并动态添加连接，不需要在模板中固定用户图片。

## 已选工作流

### 图片：`huobao_qwen_image_2_1_api.json`

- 来源：本机 ComfyUI 工作流 `Qwen-Image-2.1_文生图.json`，已从 UI 格式展开为可提交到 `/prompt` 的 API 节点图，并把输出前缀改为 `image/huobao_qwen_image_2_1`。
- 模型文件：
  - `models/diffusion_models/qwen_image_2.1_int8_convrot.safetensors`
  - `models/text_encoders/qwen3vl_8b_int8_convrot.safetensors`
  - `models/vae/qwen_image_2.1_vae_bf16.safetensors`
  - `models/text_encoders/qwen3.5_9b_qwen_image_2.1_pe_t2i.int8_convrot.safetensors`
- 默认是 1024×1024、25 步、CFG 1、Euler + simple。火宝请求带有 `size` 时，适配器会覆盖 `EmptyLatentImage` 的宽高并随机化 KSampler 种子。
- 工作流默认直接使用用户提示词，同时保留 `TextGenerate` 提示词增强分支和完整系统提示词；切换节点的 `switch` 默认关闭，避免系统提示词被当成用户提示词覆盖。
- 末端是 `SaveImage`，文件名和工作流都使用 `huobao` 前缀，火宝轮询时会从 ComfyUI `/history` 的 `images` 字段读取结果。

### 图片：`huobao_z_image_turbo_32gb_api.json`

- 官方来源：[ComfyUI Z-Image-Turbo 工作流](https://comfy.org/workflows/image_z_image_turbo-eb986f4b9142/)
- 官方下载：[image_z_image_turbo](https://comfy.org/workflows/download/eb986f4b9142.json?filename=image_z_image_turbo)
- 模型文件：
  - `models/diffusion_models/z_image_turbo_bf16.safetensors`
  - `models/text_encoders/qwen_3_4b.safetensors`
  - `models/vae/ae.safetensors`
- 默认是 1024×1024、8 步、CFG 1 的 Z-Image Turbo。火宝请求带有 `size` 时，适配器会覆盖 `EmptySD3LatentImage` 的宽高；提示词会注入唯一的正向 `CLIPTextEncode` 节点。
- 末端是 `SaveImage`，火宝轮询时会从 ComfyUI `/history` 的 `images` 字段读取结果。

### 视频：`huobao_wan22_5b_t2v_32gb_api.json`

- 官方来源：[ComfyUI Wan 2.2 5B 工作流](https://comfy.org/workflows/video_wan2_2_5B_ti2v-f83ee3caa04e/)
- 官方下载：[video_wan2_2_5B_ti2v](https://comfy.org/workflows/download/f83ee3caa04e.json?filename=video_wan2_2_5B_ti2v)
- 参考的官方示例：[Wan 2.2 image-to-video 5B JSON](https://raw.githubusercontent.com/comfyanonymous/ComfyUI_examples/master/wan22/image_to_video_wan22_5B.json)
- 模型文件：
  - `models/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors`
  - `models/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors`
  - `models/vae/wan2.2_vae.safetensors`
- 默认 832×480、121 帧、24fps，约 5.04 秒；传入分镜时长后，帧数调整为 `1 + 4 × round(秒数 × 24 / 4)`。`CreateVideo → SaveVideo` 的 MP4 也可能出现在历史结果的 `images` 字段，适配器按文件扩展名识别视频。
- 这个 5B 版本按 24GB–32GB 显存选择。零售版 RTX 4080 SUPER 通常是 16GB 显存；如果你实际看到的是 16GB，第一次请把 `Wan22ImageToVideoLatent` 的 `length` 从 121 改为 49（约 2 秒），确认能跑后再逐步增加，避免一上来 OOM。
- 火宝会注入正向 `CLIPTextEncode` 提示词。未传图片时走文生视频；一张图片会上传为 `LoadImage → Wan22ImageToVideoLatent.start_image`。该输入约束起始画面，不能把角色设定图和场景图当成独立多图参考。收到多张图会明确报错，不会只取第一张。使用包含人物和场景的完整首帧，或显式选择“接上一分镜尾帧”。

### 视频候选：`huobao_minimax_h3_reference_turbo_api.json`

- 这是 MiniMax H3 Turbo 的参考视频流程，使用 `MiniMaxH3ReferenceToVideo`，并保留视频 VAE、音频 VAE 和 `CreateVideo → SaveVideo`，适合需要人物/场景参考和原生音频的短剧镜头。
- 本地流程使用的模型文件：
  - `minimax_h3_fl2va_pruned_int8_convrot.safetensors`
  - `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors`
  - `minimax_h3_video_vae_fp16.safetensors`
  - `minimax_h3_audio_vae_fp32.safetensors`
  - `minimax_h3_turbo_v4_step600_ema.safetensors`
- 默认改为 16:9、约 0.5MP、5 秒、24fps，并使用 8 步 Turbo 采样。火宝提示词会通过 `PrimitiveStringMultiline` 注入 H3 节点。
- 本机节点支持最多 9 张独立图片。火宝按场景→角色→道具的顺序上传，通过 `ref_images.ref_image_0`、`ref_images.ref_image_1` 等独立插口绑定；`@图片1` 等编号转为 H3 的 `<Picture 1>`。不要把多张独立参考图做成 IMAGE 批次接到同一插口，该节点每个插口只取第一张。
- 参考图尺寸使用本机 schema 的 `match`，按生成像素面积缩小，控制多图采样负担；`max` 会显著增加每步计算量。尺寸、步数和权重仍按本机资源选择。
- `first_frame_url` 通过独立的 `MiniMaxH3AddGuide(frame_idx=0)` 注入；`last_frame_url` 使用 `frame_idx=-1`。这条连接保留角色/场景参考与音视频 latent。API 可指定首尾帧，当前页面提供上一分镜尾帧作为首帧的入口。
- 当前加载的是 **FL2VA** 权重。节点接收参考图并不等于已验证 Ref2VA 级别的人物身份保持效果；仍需检查面容、服装和风格，不能仅凭 Reference 节点名称承诺一致性。

## 分镜衔接

- 同场景、同机位连续动作：先完成上一分镜，在下一分镜的参考图区域选择“接上一分镜尾帧”，检查预览，再生成。提取的是最后解码帧，保持原分辨率。选择只保留在当前页面，刷新后需重选。
- H3 保留独立角色/场景图，并额外使用首帧约束；Wan 显式续接时只使用该完整首帧，素材绑定仍保留供其他模式使用。
- 换机位、换场景、闪回等正常切镜：不强制沿用尾帧，使用相同人物参考和本镜头构图。需要连续的镜头依赖上一段结果，不能把依赖链全部当作独立任务并行生成。
- 单张尾帧改善画面起点，不携带动作速度或声音，不保证逐像素一致。H3 的已安装 Motion Context 扩展可进一步带入上一段视频/音频尾部，但需要持久化/读取前段 latent，并同步裁掉视频和音频的重叠部分；本次页面和适配器未实现这个模式。
- 页面时长是目标时长，旧成片不会自动变长。H3 帧数按 `17k + 5` 向上对齐，Wan 按 `4k + 1` 对齐，因此输出略有差异。当前工作流仍使用自身分辨率，不会因选择“720p”自动变成 1280×720。

## 接入火宝

火宝当前默认从下面的目录按“模型名 + `.json`”读取 API 工作流：

```text
D:\Comfy-Desktop\ComfyUI-Installs\ComfyUI\ComfyUI\user\default\toonflow_api
```

四个 API 文件已经复制到该目录；原来的 `zib+zit+最大程度保持原样双采+.json` 保持不动。在模型文件准备好后，再到火宝「设置 → AI 服务」分别建立或编辑本地 ComfyUI 配置，模型名填写：

```text
huobao_qwen_image_2_1_api
huobao_z_image_turbo_32gb_api
huobao_wan22_5b_t2v_32gb_api
huobao_minimax_h3_reference_turbo_api
```

模型名必须与文件名去掉 `.json` 后完全一致。图片服务默认优先 Qwen Image 2.1，也可以选择 Z-Image；Wan 2.2 和 MiniMax H3 都是视频服务候选，先分别在 ComfyUI 中单独运行一次确认模型、节点和显存，再把其中一个启用到火宝。Base URL 使用当前 ComfyUI 地址（截图中是 `http://127.0.0.1:8188`）。

如果想让火宝直接从这个新目录读取，可以把后端环境变量 `COMFYUI_WORKFLOW_DIR` 指向本目录；修改后需要重启后端。默认适配器只按文件名读取目录根部，不会自动递归扫描子文件夹。

## 原始来源文件

- `source_qwen_image_2_1_ui.json`：本机 Qwen Image 2.1 页面保存的 UI 工作流参考（源文件位于 ComfyUI 的 `user/default/workflows/V4-网络流程图-本地/`）。
- `source_z_image_turbo_ui.json`：官方 Z-Image 页面下载的 UI 工作流。
- `source_z_image_readme.md`：官方 Z-Image 模型文件说明。
- `source_wan22_5b_ti2v_ui.json`：官方 Wan 2.2 5B 页面下载的 UI 工作流。
- `source_wan22_image_to_video_5B_ui.json`：官方 GitHub Wan 2.2 5B 示例 UI 工作流。
- `source_minimax_h3_reference_api.json`：本机已有的 MiniMax H3 参考视频 API 工作流原始副本。

`huobao_*_api.json` 是给 ComfyUI `/prompt` 使用的 API 节点图；`source_*_ui.json` 是 UI 工作流参考，不能直接提交给 `/prompt`。MiniMax H3 新文件是在原参考流程上增加了火宝可识别的 `PrimitiveStringMultiline` 提示词入口。
